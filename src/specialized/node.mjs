import {rollup} from 'rollup';
import sourcePack from '../../generated/runtime-sources.json';
import {linkPlayer} from './link.mjs';
import {prepareExtension as prepare} from './extensions.mjs';
export {inspectExtension} from './inspect-node.mjs';
export const linkSpecialized = options => linkPlayer({...options, sourcePack}, rollup);
export const prepareExtension = options => prepare(options, sourcePack, rollup);
