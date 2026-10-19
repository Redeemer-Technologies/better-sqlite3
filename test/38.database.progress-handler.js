'use strict';
const threads = require('worker_threads');
const Database = require('../.');

// A query that keeps the virtual machine busy for a long time.
const SLOW = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM (SELECT x FROM c LIMIT 1000000000)';

if (threads.isMainThread) {
	describe('Database#progressHandler()', function () {
		beforeEach(function () {
			this.db = new Database(util.next());
			this.db.exec('CREATE TABLE entries (a INTEGER)');
		});
		afterEach(function () {
			this.db.close();
		});

		it('should throw an exception if the correct arguments are not provided', function () {
			expect(() => this.db.progressHandler(100)).to.throw(TypeError);
			expect(() => this.db.progressHandler(() => {})).to.throw(TypeError);
			expect(() => this.db.progressHandler('100', () => {})).to.throw(TypeError);
			expect(() => this.db.progressHandler(1.5, () => {})).to.throw(TypeError);
			expect(() => this.db.progressHandler(100, {})).to.throw(TypeError);
		});
		it('should throw an exception if the interval is not positive', function () {
			expect(() => this.db.progressHandler(0, () => {})).to.throw(RangeError);
			expect(() => this.db.progressHandler(-1, () => {})).to.throw(RangeError);
		});
		it('should return the database object', function () {
			expect(this.db.progressHandler(100, () => {})).to.equal(this.db);
			expect(this.db.progressHandler()).to.equal(this.db);
		});
		it('should invoke the callback while a statement runs', function () {
			let calls = 0;
			this.db.progressHandler(100, () => { calls += 1; });
			this.db.prepare('SELECT count(*) FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 10000) SELECT x FROM c)').get();
			expect(calls).to.be.above(10);
		});
		it('should interrupt the statement when the callback returns a truthy value', function () {
			let calls = 0;
			this.db.progressHandler(1000, () => ++calls >= 5);
			expect(() => this.db.prepare(SLOW).get()).to.throw(Database.SqliteError).with.property('code', 'SQLITE_INTERRUPT');
			expect(calls).to.equal(5);
		});
		it('should interrupt Database#exec()', function () {
			this.db.progressHandler(1000, () => true);
			expect(() => this.db.exec(SLOW)).to.throw(Database.SqliteError).with.property('code', 'SQLITE_INTERRUPT');
		});
		it('should leave the connection usable after an interruption', function () {
			let stop = true;
			this.db.progressHandler(1000, () => stop);
			expect(() => this.db.prepare(SLOW).get()).to.throw(Database.SqliteError);
			stop = false;
			this.db.prepare('INSERT INTO entries VALUES (?)').run(1);
			expect(this.db.prepare('SELECT a FROM entries').pluck().all()).to.deep.equal([1]);
		});
		it('should roll back an interrupted write inside a transaction', function () {
			let stop = false;
			this.db.progressHandler(1000, () => stop);
			this.db.exec('BEGIN');
			this.db.prepare('INSERT INTO entries VALUES (1)').run();
			stop = true;
			expect(() => this.db.exec(`INSERT INTO entries ${SLOW}`)).to.throw(Database.SqliteError).with.property('code', 'SQLITE_INTERRUPT');
			stop = false;
			if (this.db.inTransaction) this.db.exec('ROLLBACK');
			expect(this.db.prepare('SELECT count(*) FROM entries').pluck().get()).to.equal(0);
		});
		it('should propagate exceptions thrown by the callback', function () {
			const err = new Error('foobar');
			this.db.progressHandler(1000, () => { throw err; });
			expect(() => this.db.prepare(SLOW).get()).to.throw(err);
			expect(() => this.db.exec(SLOW)).to.throw(err);
		});
		it('should not allow the callback to use the database', function () {
			this.db.progressHandler(1000, () => this.db.progressHandler());
			expect(() => this.db.prepare(SLOW).get()).to.throw(TypeError, /busy/);
			this.db.progressHandler(1000, () => this.db.exec('SELECT 1'));
			expect(() => this.db.prepare(SLOW).get()).to.throw(TypeError, /busy/);
		});
		it('should remove the handler when invoked without arguments', function () {
			let calls = 0;
			this.db.progressHandler(100, () => { calls += 1; });
			this.db.progressHandler();
			this.db.prepare('SELECT count(*) FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 10000) SELECT x FROM c)').get();
			expect(calls).to.equal(0);
		});
		it('should interrupt a running statement when its worker thread is terminated', function () {
			this.timeout(20000);
			this.slow(5000);
			const worker = new threads.Worker(__filename, { workerData: util.next() });
			return new Promise((resolve, reject) => {
				worker.on('error', reject);
				worker.on('message', () => {
					const started = Date.now();
					setTimeout(() => worker.terminate().then(() => {
						try {
							expect(Date.now() - started).to.be.below(5000);
							resolve();
						} catch (err) {
							reject(err);
						}
					}, reject), 200);
				});
			});
		});
	});
} else {
	const db = new Database(threads.workerData);
	db.progressHandler(1000, () => false);
	threads.parentPort.postMessage('started');
	db.prepare(SLOW).get();
}
