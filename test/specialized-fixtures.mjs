import {createHash} from 'node:crypto';
export const costumeSVG = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><path fill="white" d="M0 0h480v360H0z"/></svg>';
export const costumeId = createHash('md5').update(costumeSVG).digest('hex');
export const fixtureProject = ({extension = false, branch = false, iterations = 50} = {}) => {
  const target = {isStage: true, name: 'Stage', variables: {answer: ['answer', 0]}, lists: {}, broadcasts: {},
    blocks: {}, comments: {}, currentCostume: 0, costumes: [{name: 'backdrop', assetId: costumeId, md5ext: `${costumeId}.svg`,
      dataFormat: 'svg', rotationCenterX: 240, rotationCenterY: 180, bitmapResolution: 1}], sounds: [], volume: 100, layerOrder: 0,
    tempo: 60, videoTransparency: 50, videoState: 'off', textToSpeechLanguage: null};
  const blocks = target.blocks;
  const block = (opcode, parent, next, inputs = {}, fields = {}) => ({opcode, parent, next, inputs, fields, shadow: false, topLevel: !parent});
  blocks.hat = block('event_whenflagclicked', null, 'set');
  blocks.set = block('data_setvariableto', 'hat', extension ? 'say' : 'repeat',
    {VALUE: extension ? [3, 'reporter', [4, '0']] : [1, [4, '3']]}, {VARIABLE: ['answer', 'answer']});
  if (extension) blocks.reporter = block('fixture_value', 'set', null);
  else {
    blocks.repeat = block('control_repeat', 'set', 'say', {TIMES: [1, [4, String(iterations)]], SUBSTACK: [2, 'change']});
    blocks.change = block('data_changevariableby', 'repeat', null, {VALUE: [1, [4, '1']]}, {VARIABLE: ['answer', 'answer']});
  }
  blocks.say = block('looks_say', extension ? 'set' : 'repeat', null, {MESSAGE: [1, [10, 'done']]});
  if (extension && branch) {
    blocks.set.next = 'choose';
    blocks.choose = block('fixture_choose', 'set', 'say', {SUBSTACK: [2, 'increment']});
    blocks.increment = block('data_changevariableby', 'choose', null, {VALUE: [1, [4, '1']]}, {VARIABLE: ['answer', 'answer']});
    blocks.say.parent = 'choose';
  }
  return {targets: [target], monitors: [{id: 'answer', mode: 'default', opcode: 'data_variable',
    params: {VARIABLE: 'answer'}, spriteName: null, value: 0, width: 0, height: 0, x: 5, y: 5, visible: true,
    sliderMin: 0, sliderMax: 100, isDiscrete: true}], extensions: extension ? ['fixture'] : [],
    extensionURLs: extension ? {fixture: 'https://test.invalid/fixture.js'} : {},
    meta: {semver: '3.0.0', vm: '1.0.0', agent: 'specialized-tests'}};
};

export const fixedExtension = {
  url: 'https://test.invalid/fixture.js',
  source: `Scratch.extensions.register({
    getInfo() { return {id: 'fixture', name: 'Fixture', blocks: [
      {opcode: 'value', blockType: Scratch.BlockType.REPORTER, text: 'async value'},
      {opcode: 'choose', blockType: Scratch.BlockType.CONDITIONAL, branchCount: 1, text: 'async branch'}]}; },
    async value() { await new Promise(resolve => setTimeout(resolve, 20)); return 42; },
    async choose() { await new Promise(resolve => setTimeout(resolve, 10)); return 1; }
  });`
};
