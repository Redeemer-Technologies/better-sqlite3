'use strict';
const Database = require('../.');

describe('Database#status()', function () {
	beforeEach(function () {
		this.db = new Database(util.next());
		this.db.exec('CREATE TABLE entries (a INTEGER, b TEXT)');
		this.db.prepare('WITH RECURSIVE s(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM s LIMIT 5000) INSERT INTO entries SELECT value, hex(randomblob(100)) FROM s').run();
	});
	afterEach(function () {
		this.db.close();
	});

	it('should throw an exception if reset is not a boolean', function () {
		expect(() => this.db.status(1)).to.throw(TypeError);
		expect(() => this.db.status('true')).to.throw(TypeError);
	});
	it('should return the page cache and temporary file counters', function () {
		const status = this.db.status();
		expect(Object.keys(status)).to.deep.equal(['cacheHits', 'cacheMisses', 'cacheWrites', 'cacheSpills', 'tempSpillBytes', 'cacheUsedBytes']);
		for (const value of Object.values(status)) expect(value).to.be.a('number').and.at.least(0);
		expect(status.cacheWrites).to.be.above(0);
	});
	it('should count page cache hits as statements read', function () {
		this.db.status(true);
		this.db.prepare('SELECT sum(length(b)) FROM entries').get();
		expect(this.db.status().cacheHits).to.be.above(0);
	});
	it('should set the counters to zero after returning them when reset is true', function () {
		this.db.prepare('SELECT sum(length(b)) FROM entries').get();
		const before = this.db.status(true);
		expect(before.cacheHits).to.be.above(0);
		const after = this.db.status();
		expect(after.cacheHits).to.equal(0);
		expect(after.cacheWrites).to.equal(0);
		expect(after.cacheUsedBytes).to.equal(before.cacheUsedBytes);
	});
	it('should throw an exception if the database is closed', function () {
		this.db.close();
		expect(() => this.db.status()).to.throw(TypeError);
	});
});

describe('Database#collectScanStatus()', function () {
	beforeEach(function () {
		this.db = new Database(util.next());
		this.db.exec('CREATE TABLE entries (a INTEGER)');
		this.db.prepare('WITH RECURSIVE s(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM s LIMIT 1000) INSERT INTO entries SELECT value FROM s').run();
	});
	afterEach(function () {
		this.db.close();
	});

	it('should throw an exception if enabled is not a boolean', function () {
		expect(() => this.db.collectScanStatus(1)).to.throw(TypeError);
	});
	it('should return the database object', function () {
		expect(this.db.collectScanStatus()).to.equal(this.db);
		expect(this.db.collectScanStatus(false)).to.equal(this.db);
	});
	it('should be off when the connection opens', function () {
		const stmt = this.db.prepare('SELECT count(*) FROM entries WHERE a > 10');
		stmt.get();
		expect(stmt.scanStatus().steps).to.deep.equal([]);
	});
	it('should collect for statements prepared and run while it is on', function () {
		this.db.collectScanStatus();
		const stmt = this.db.prepare('SELECT count(*) FROM entries WHERE a > 10');
		stmt.get();
		expect(stmt.scanStatus().steps).to.have.lengthOf(1);
		expect(stmt.scanStatus().steps[0].rowsVisited).to.equal(1000);
	});
	it('should prepare statements again when it changes, so they collect as it says', function () {
		this.db.collectScanStatus();
		const stmt = this.db.prepare('SELECT count(*) FROM entries WHERE a > 10');
		stmt.get();
		expect(stmt.scanStatus().steps).to.have.lengthOf(1);
		this.db.collectScanStatus(false);
		stmt.get();
		expect(stmt.status().reprepares).to.equal(1);
		expect(stmt.scanStatus().steps).to.deep.equal([]);
	});
});
