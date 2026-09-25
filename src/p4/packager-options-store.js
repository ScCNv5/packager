import writablePersistentStore from './persistent-store';
import {error} from './stores';
import {validatePackagerOptions} from '../packager/compile-project';

const writablePackagerOptionsStore = (key, defaultOptions) => writablePersistentStore(key, defaultOptions, savedOptions => {
  try {
    validatePackagerOptions(savedOptions);
    return savedOptions;
  } catch (migration) {
    error.set(migration);
    // Reset rejected compiler settings. The persistent store's merge removes
    // obsolete fields while preserving unrelated settings supported by defaults.
    return {...savedOptions, compiler: defaultOptions.compiler};
  }
});

export default writablePackagerOptionsStore;
