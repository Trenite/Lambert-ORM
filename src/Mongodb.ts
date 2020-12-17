import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Collection, Connection, Types } from "mongoose";
import { ChangeStream } from "mongodb";
import { Provider } from "./Provider";
import { ProviderCache, ProviderCacheOptions } from "./ProviderCache";
import { Database } from "./Database";
import fs from "fs";
import { Datastore, DatastoreInterface, DatastoreProxyPath } from "./Datastore";

Array.prototype.last = function () {
	return this[this.length - 1];
};

declare global {
	interface Array<T> {
		last(): T;
	}
}

export class MongoDatabase implements Database<MongodbProvider> {
	private mongod?: MongoMemoryServer;
	public mongoConnection?: Connection;
	public provider = MongodbProvider;

	constructor(private uri?: string) {}

	get data(): any {
		return Datastore<MongodbProvider>(this);
	}

	async init() {
		if (!this.uri) {
			const dbPath = `${__dirname}/../database/`;

			if (!fs.existsSync(dbPath)) fs.mkdirSync(dbPath);
			this.mongod = new MongoMemoryServer({
				instance: {
					dbName: "lambert",
					dbPath,
					storageEngine: "wiredTiger",
					auth: false,
					args: [],
					port: 54618,
				},
				autoStart: true,
			});
			this.uri = await this.mongod?.getUri();
		}
		this.mongoConnection = await mongoose.createConnection(<string>this.uri, {
			useNewUrlParser: true,
			useUnifiedTopology: true,
		});
	}

	async destroy() {
		await Promise.all([this.mongoConnection?.close(), this.mongod?.stop()]);
	}
}

export class MongodbProviderCache extends ProviderCache {
	private changeStream: ChangeStream;

	constructor(public provider: MongodbProvider, opts?: ProviderCacheOptions) {
		// @ts-ignore
		super(provider, opts);
	}

	init() {
		this.changeStream = this.provider.collection.watch(this.provider.pipe);
		this.changeStream.on("change", this.update);
		return super.init();
	}

	update = (e: any) => {
		console.log(this, e);
	};

	async destroy() {
		this.changeStream.off("change", this.update);
		await this.changeStream.close();
		return super.destroy();
	}
}

function decycle(obj: any, stack = []): any {
	if (!obj || typeof obj !== "object") return obj;

	// @ts-ignore
	if (stack.includes(obj)) return null;
	// @ts-ignore
	let s = stack.concat([obj]);

	return Array.isArray(obj)
		? obj.map((x) => decycle(x, s))
		: // @ts-ignore
		  Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, decycle(v, s)]));
}

export class MongodbProvider implements Provider {
	public collection: Collection;
	public pipe: any[];
	public document?: any;
	public subpath?: string;
	public updatepath?: string;
	public options: any = {};
	public arrayFilters: any[] = [];

	public get cache() {
		return new MongodbProviderCache(this);
	}

	constructor(private db: MongoDatabase, private path: DatastoreProxyPath) {
		const collection = path[0];

		if (typeof collection.filter == "function" || typeof collection.filter == "string") {
			// run js on mongodb: https://docs.mongodb.com/manual/reference/operator/query/where/
			collection.filter = { $where: collection.filter.toString() };
			this.document = collection.filter;
		} else if (typeof collection.filter == "object" && collection.filter) {
			this.document = collection.filter;

			// @ts-ignore
			if (collection.filter?._id) collection.filter._id = mongoose.Types.ObjectId(collection.filter._id);

			collection.filter = { $match: collection.filter };
		}

		this.path = path.slice(1);
		path = this.path;

		if (!db.mongoConnection) throw new Error("Database not connected");

		this.collection = db.mongoConnection.collection(collection.name);

		if (collection.filter) {
			var pipe: any[] = [];
			var arrayFilters: any[] = [];
			var up: string[] = [];
			var i = 0;

			pipe.push(collection.filter);

			this.path.forEach((x, i) => {
				if (!x.filter) {
					up.push(x.name);
					if (!pipe.last()["$project"]) return pipe.push({ $project: { [x.name]: "$" + x.name } });

					var projection = pipe.last()["$project"];
					var key = Object.keys(projection)[0];
					projection[key] += "." + x.name;
					return;
				}

				var id = x.name + i++;

				up.push(x.name, `$[${id}]`);
				arrayFilters.push(this.convertFilterToQuery({ [id]: x.filter }));

				pipe.push({ $unwind: "$" + x.name }, { $replaceRoot: { newRoot: "$" + x.name } }, { $match: x.filter });
			});

			this.pipe = pipe;
			this.subpath = path.length ? path.map((x) => x.name).join(".") : undefined;
			this.updatepath = up.length ? up.join(".") : undefined;
			this.arrayFilters = arrayFilters;
		}

		this.options.upsert = true;
	}

	convertFilterToQuery(obj: any) {
		var walked = [];
		var res: any = {};
		var stack: any = [{ obj: obj, stack: "" }];

		while (stack.length > 0) {
			var item = stack.pop();
			var obj = item.obj;
			for (var property in obj) {
				if (obj.hasOwnProperty(property)) {
					if (typeof obj[property] == "object" && !Array.isArray(obj[property])) {
						var alreadyFound = false;
						for (var i = 0; i < walked.length; i++) {
							if (walked[i] === obj[property]) {
								alreadyFound = true;
								break;
							}
						}
						if (!alreadyFound) {
							walked.push(obj[property]);
							stack.push({ obj: obj[property], stack: item.stack + "." + property });
						}
					} else {
						if (Array.isArray(obj[property])) obj[property] = { $in: obj[property] };
						var id = (item.stack + ".").slice(1);
						res[id + property] = obj[property];
					}
				}
			}
		}
		return res;
	}

	delete() {
		if (this.updatepath) {
			return this.checkIfModified(
				this.collection.updateOne(
					this.document,
					{ $unset: { [this.updatepath]: "" } },
					{ ...this.options, arrayFilters: this.arrayFilters }
				)
			);
		}
		if (this.document) return this.collection.deleteOne(this.document);

		return this.collection.conn.dropCollection(this.collection.name);
	}

	async get() {
		if (this.pipe.length) {
			var lastProp = Object.keys(this.pipe.last()["$project"] || {})[0];
			if (this.pipe.last()["$match"] && this.pipe.length > 1)
				this.pipe.push({ $project: { [lastProp]: "$$ROOT" } }); // used to get properly get the element if last pipe operator was an array filter
			var result = await this.collection.aggregate(this.pipe).toArray();
			return result && result.length ? (lastProp ? result[0][lastProp] : result[0]) : undefined;
		}

		return this.collection.find({}).toArray();
	}

	set(value: any): any {
		value = decycle(value);
		if (this.updatepath) {
			return this.checkIfModified(
				this.collection.updateOne(
					this.document,
					{ $set: { [this.updatepath]: value } },
					{ ...this.options, arrayFilters: this.arrayFilters }
				)
			);
		}

		// set collection -> insert all elements
		if (Array.isArray(value)) {
			// do not use insertmany -> fails if already exists
			var operations = value.map((x) => {
				return {
					updateOne: {
						filter: { id: x.id },
						update: {
							$set: x,
						},
						upsert: true,
					},
				};
			});
			return this.collection.bulkWrite(operations, {
				ordered: false,
			});
		} else {
			if (this.document) {
				return this.checkIfModified(this.collection.updateOne(this.document, { $set: value }, this.options));
			}
			return this.collection.insertOne(value);
		}
	}

	async exists() {
		// TODO make it efficient and do not fetch it
		return !!(await this.get());
	}

	async checkIfModified(result: any) {
		result = await result;
		return result.modifiedCount > 0;
	}

	push(element: any) {
		if (this.updatepath) {
			return this.checkIfModified(
				this.collection.updateOne(
					this.document,
					{ $push: { [this.updatepath]: element } },
					{ ...this.options, arrayFilters: this.arrayFilters }
				)
			);
		}

		return this.set(element);
	}

	pull() {
		if (this.subpath) {
			var { filter } = this.path.last();
			if (!filter) throw "the last property must specify a filter";
			return this.checkIfModified(
				this.collection.updateOne(this.document, { $pull: { [this.subpath]: filter } }, this.options)
			);
		}

		return this.pop();
	}

	pop() {
		// TODO
		return this.collection.deleteOne({});
	}

	async first() {
		if (this.subpath) {
			var { name } = this.path.last();

			var result = await this.collection
				.aggregate([
					...this.pipe,
					{ $unwind: "$" + name },
					{ $replaceRoot: { newRoot: "$" + name } },
					{ $limit: 1 },
				])
				.toArray();
			return result && result.length ? result[0] : undefined;
		}

		return this.collection.findOne({}, { sort: { $natural: 1 } });
	}

	last() {
		if (this.subpath) {
			// TODO
			return this.collection.findOne(this.document);
		}

		return this.collection.findOne({}, { sort: { $natural: -1 } });
	}

	async random() {
		if (this.subpath) {
			var { name } = this.path.last();

			var result = await this.collection
				.aggregate([
					...this.pipe,
					{ $unwind: "$" + name },
					{ $replaceRoot: { newRoot: "$" + name } },
					{ $sample: { size: 1 } },
				])
				.toArray();
			return result && result.length ? result[0] : undefined;
		}

		return this.collection.aggregate([{ $sample: { size: 1 } }]);
	}

	__getProvider() {
		return this;
	}
}