import {writable} from 'svelte/store';
// Standard JSON can't represent values such as Infinity, which some options use.
import * as ExtendedJSON from '@turbowarp/json';
import merge from './merge';
import serialize from './serialize';

const writablePersistentStore = (key, defaultValue, restore = value => value) => {
  let value = ExtendedJSON.parse(ExtendedJSON.stringify(defaultValue));
  const localValue = ExtendedJSON.parse(localStorage.getItem(key));
  if (localValue) {
    value = merge(restore(localValue), value);
  }
  const store = writable(value, () => {
    const unsubscribe = store.subscribe(value => {
      const serialized = serialize(value, defaultValue);
      if (serialized === null) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, ExtendedJSON.stringify(serialized));
      }
    });
    return unsubscribe;
  });
  return store;
};

export default writablePersistentStore;
