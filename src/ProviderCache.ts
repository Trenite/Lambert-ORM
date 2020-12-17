import { Provider } from "./Provider";
import { EventEmitter } from "events";

export type ProviderCacheOptions = {};

export class ProviderCache extends EventEmitter {
	private cache: any;
	private timeout: NodeJS.Timeout;
	constructor(public provider: Provider, private opts?: ProviderCacheOptions) {
		super();
	}

	async init() {
		this.cache = await this.provider.get();
	}

	delete() {
		this.cache = undefined;
		return this.provider.delete();
	}
	set(value: any) {
		this.cache = value;
		return this.provider.set(value);
	}
	get() {
		return this.cache;
	}
	exists() {
		return !!this.cache;
	}
	push(value: any) {
		this.cache = (this.cache || []).push(value);
		return this.provider.push(value);
	}
	first() {
		return (this.cache || []).first();
	}
	last() {
		return (this.cache || []).last();
	}
	random() {
		return (this.cache || []).random();
	}

	destroy() {
		this.cache = null;
	}
}