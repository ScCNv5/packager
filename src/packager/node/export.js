import Packager from '../packager';
import {downloadProject} from '../download-project';
import NodeAdapter from './adapter';
import Image from './image';
import {setAdapter} from '../adapter';
import {compileProject} from '../compile-project';

setAdapter(new NodeAdapter());

export {
  Packager,
  Image,
  compileProject,
  downloadProject as loadProject
};
