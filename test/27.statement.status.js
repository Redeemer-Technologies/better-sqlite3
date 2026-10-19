'use strict';
const Database = require('../.');

describe('Statement#status()', function () {
	beforeEach(function () {
		this.db = new Database(util.next());
		this.db.exec('CREATE TABLE entries (a INTEGER, b TEXT)');
		this.db.prepare('WITH RECURSIVE s(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM s LIMIT 1000) INSERT INTO entries SELECT value, hex(randomblob(4)) FROM s').run();
	});
	afterEach(function () {
		this.db.close();
	});

	it('should throw an exception if reset is not a boolean', function () {
		const stmt = this.db.prepare('SELECT * FROM entries');
		expect(() => stmt.status(1)).to.throw(TypeError);
	});
	it('should return the statement counters', function () {
		const stmt = this.db.prepare('SELECT * FROM entries ORDER BY b');
		stmt.all();
		const status = stmt.status();
		expect(Object.keys(status)).to.deep.equal(['fullscanSteps', 'sorts', 'autoindexInserts', 'vmSteps', 'reprepares', 'runs', 'filterMisses', 'filterHits', 'memoryUsed']);
		expect(status.fullscanSteps).to.equal(999);
		expect(status.sorts).to.equal(1);
		expect(status.runs).to.equal(1);
		expect(status.vmSteps).to.be.above(1000);
		expect(status.memoryUsed).to.be.above(0);
	});
	it('should count automatic indexes', function () {
		this.db.exec('CREATE TABLE others (a INTEGER)');
		this.db.prepare('WITH RECURSIVE s(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM s LIMIT 100) INSERT INTO others SELECT value FROM s').run();
		const stmt = this.db.prepare('SELECT count(*) FROM others JOIN entries ON entries.a = others.a');
		stmt.get();
		expect(stmt.status().autoindexInserts).to.be.above(0);
	});
	it('should accumulate over runs, and after an iterator stops early', function () {
		const stmt = this.db.prepare('SELECT * FROM entries');
		stmt.all();
		for (const _row of stmt.iterate()) break;
		expect(stmt.status().runs).to.equal(2);
	});
	it('should set the counters to zero after returning them when reset is true', function () {
		const stmt = this.db.prepare('SELECT * FROM entries');
		stmt.all();
		expect(stmt.status(true).vmSteps).to.be.above(0);
		const after = stmt.status();
		expect(after.vmSteps).to.equal(0);
		expect(after.runs).to.equal(0);
		expect(after.memoryUsed).to.be.above(0);
	});
	it('should be readable while an iterator is open', function () {
		const stmt = this.db.prepare('SELECT * FROM entries');
		const iterator = stmt.iterate();
		iterator.next();
		expect(stmt.status().vmSteps).to.be.above(0);
		iterator.return();
	});
});

describe('Statement#scanStatus()', function () {
	beforeEach(function () {
		this.db = new Database(util.next());
		this.db.exec('CREATE TABLE entries (a INTEGER, b TEXT); CREATE INDEX entries_a ON entries (a)');
		this.db.prepare('WITH RECURSIVE s(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM s LIMIT 1000) INSERT INTO entries SELECT value, value % 7 FROM s').run();
		this.db.collectScanStatus();
	});
	afterEach(function () {
		this.db.close();
	});

	it('should throw an exception if reset is not a boolean', function () {
		const stmt = this.db.prepare('SELECT * FROM entries');
		expect(() => stmt.scanStatus(1)).to.throw(TypeError);
	});
	it('should describe each element of the query plan with what it did', function () {
		const stmt = this.db.prepare('SELECT b, count(*) FROM entries WHERE a > 100 GROUP BY b');
		stmt.all();
		const { cycles, steps } = stmt.scanStatus();
		const plan = this.db.prepare('EXPLAIN QUERY PLAN SELECT b, count(*) FROM entries WHERE a > 100 GROUP BY b').all();
		expect(steps.map(s => [s.id, s.parentId, s.explain])).to.deep.equal(plan.map(p => [p.id, p.parent, p.detail]));

		const search = steps.find(s => s.explain.startsWith('SEARCH'));
		expect(search.name).to.equal('entries_a');
		expect(search.loops).to.equal(1);
		expect(search.rowsVisited).to.equal(900);
		expect(search.estimatedRows).to.be.a('number').and.above(0);
		expect(search.cycles).to.be.a('number').and.above(0);

		const sort = steps.find(s => s.explain.includes('TEMP B-TREE'));
		expect(sort.name).to.equal(null);
		expect(sort.estimatedRows).to.equal(null);

		expect(cycles).to.be.at.least(search.cycles);
	});
	it('should count each loop of an inner loop', function () {
		this.db.exec('CREATE TABLE others (a INTEGER)');
		this.db.prepare('WITH RECURSIVE s(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM s LIMIT 10) INSERT INTO others SELECT value FROM s').run();
		const stmt = this.db.prepare('SELECT count(*) FROM others JOIN entries ON entries.a = others.a');
		stmt.get();
		const inner = stmt.scanStatus().steps.find(s => s.name === 'entries_a');
		expect(inner.loops).to.equal(10);
		expect(inner.rowsVisited).to.equal(10);
	});
	it('should accumulate over runs until reset is true', function () {
		const stmt = this.db.prepare('SELECT count(*) FROM entries WHERE b = ?');
		stmt.get('1');
		stmt.get('2');
		expect(stmt.scanStatus(true).steps[0].loops).to.equal(2);
		expect(stmt.scanStatus().steps[0].loops).to.equal(0);
	});
	it('should give null where SQLite has no value', function () {
		const stmt = this.db.prepare('SELECT 1');
		stmt.get();
		expect(stmt.scanStatus().steps).to.deep.equal([
			{ id: 1, parentId: 0, explain: 'SCAN CONSTANT ROW', name: null, loops: null, rowsVisited: null, estimatedRows: null, cycles: null },
		]);
	});
	it('should have no steps when the connection did not collect scan status', function () {
		this.db.collectScanStatus(false);
		const stmt = this.db.prepare('SELECT count(*) FROM entries');
		stmt.get();
		expect(stmt.scanStatus().steps).to.deep.equal([]);
	});
});
