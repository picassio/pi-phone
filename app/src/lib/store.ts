// A minimal external store for React: `useStore(store)` re-renders on `set`.
import { useSyncExternalStore } from "react";

export interface Store<T> {
	get(): T;
	set(next: T | ((current: T) => T)): void;
	subscribe(listener: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
	let value = initial;
	const listeners = new Set<() => void>();
	return {
		get: () => value,
		set(next) {
			value = typeof next === "function" ? (next as (current: T) => T)(value) : next;
			for (const listener of listeners) listener();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

export function useStore<T>(store: Store<T>): T {
	return useSyncExternalStore(store.subscribe, store.get, store.get);
}
