import { exists, mkdirp, readFile, remove, stat } from 'fs-promise';
import { log, wasReported } from './log.js';
import { need, system } from 'pkg-fetch';
import assert from 'assert';
import help from './help';
import { isPackageJson } from '../prelude/common.js';
import minimist from 'minimist';
import packer from './packer.js';
import path from 'path';
import { plusx } from './chmod.js';
import producer from './producer.js';
import walker from './walker.js';

// http://www.openwall.com/lists/musl/2012/12/08/4

const { hostArch, hostPlatform, isValidNodeRange, knownArchs,
  knownPlatforms, toFancyArch, toFancyPlatform } = system;
const hostNodeRange = 'node' + process.version.match(/^v(\d+)/)[1];

function parseTargets (items) {
  // [ 'node6-macos-x64', 'node6-linux-x64' ]
  const targets = [];
  for (const item of items) {
    const target = {
      nodeRange: hostNodeRange,
      platform: hostPlatform,
      arch: hostArch
    };
    if (item !== 'host') {
      for (const token of item.split('-')) {
        if (!token) continue;
        if (isValidNodeRange(token)) {
          target.nodeRange = token;
          continue;
        }
        const p = toFancyPlatform(token);
        if (knownPlatforms.indexOf(p) >= 0) {
          target.platform = p;
          continue;
        }
        const a = toFancyArch(token);
        if (knownArchs.indexOf(a) >= 0) {
          target.arch = a;
          continue;
        }
        throw wasReported(`Unknown token '${token}' in '${item}'`);
      }
    }
    targets.push(target);
  }
  return targets;
}

function stringifyTarget (target) {
  const { nodeRange, platform, arch } = target;
  return `${nodeRange}-${platform}-${arch}`;
}

function differentParts (targets) {
  const nodeRanges = {};
  const platforms = {};
  const archs = {};
  for (const target of targets) {
    nodeRanges[target.nodeRange] = true;
    platforms[target.platform] = true;
    archs[target.arch] = true;
  }
  const result = {};
  if (Object.keys(nodeRanges).length > 1) {
    result.nodeRange = true;
  }
  if (Object.keys(platforms).length > 1) {
    result.platform = true;
  }
  if (Object.keys(archs).length > 1) {
    result.arch = true;
  }
  return result;
}

function stringifyTargetForOutput (output, target, different) {
  const a = [ output ];
  if (different.nodeRange) a.push(target.nodeRange);
  if (different.platform) a.push(target.platform);
  if (different.arch) a.push(target.arch);
  return a.join('-');
}

function fabricatorForTarget (target) {
  const { nodeRange, arch } = target;
  return { nodeRange, platform: hostPlatform, arch };
}

const dryRunResults = {};

async function needWithDryRun (target) {
  const target2 = Object.assign({ dryRun: true }, target);
  const result = await need(target2);
  assert([ 'exists', 'fetched', 'built' ].indexOf(result) >= 0);
  dryRunResults[result] = true;
}

const targetsCache = {};

async function needViaCache (target) {
  const s = stringifyTarget(target);
  let c = targetsCache[s];
  if (c) return c;
  c = await need(target);
  targetsCache[s] = c;
  return c;
}

export async function exec (argv2) { // eslint-disable-line complexity
  const argv = minimist(argv2, {
    boolean: [ 'b', 'build', 'd', 'debug', 'h', 'help' ],
    string: [ '_', 'c', 'config', 'o', 'options', 'output',
      'outdir', 'out-dir', 't', 'target', 'targets' ]
  });

  if (argv.h || argv.help) {
    help();
    return;
  }

  // debug

  log.debugMode = argv.d || argv.debug;

  // forceBuild

  const forceBuild = argv.b || argv.build;

  // _

  if (!argv._.length) {
    throw wasReported('Entry file/directory is expected',
      [ 'Pass --help to see usage information' ]);
  }
  if (argv._.length > 1) {
    throw wasReported('Not more than one entry file/directory is expected');
  }

  // input

  let input = path.resolve(argv._[0]);

  if (!await exists(input)) {
    throw wasReported(`Input file ${input} does not exist`);
  }
  if ((await stat(input)).isDirectory()) {
    input = path.join(input, 'package.json');
    if (!await exists(input)) {
      throw wasReported(`Input file ${input} does not exist`);
    }
  }

  // inputJson

  let inputJson = null;

  if (isPackageJson(input)) {
    inputJson = JSON.parse(await readFile(input));
  }

  // inputBin

  let inputBin = null;

  if (inputJson) {
    let bin = inputJson.bin;
    if (bin) {
      if (typeof bin === 'object') {
        if (bin[inputJson.name]) {
          bin = bin[inputJson.name];
        } else {
          bin = bin[Object.keys(bin)[0]]; // TODO multiple inputs to compile them all?
        }
      }
      inputBin = path.resolve(path.dirname(input), bin);
      if (!await exists(inputBin)) {
        throw wasReported(`${inputBin} does not exist (taken from package.json 'bin' property)`);
      }
    }
  }

  if (inputJson && !inputBin) {
    throw wasReported(`Property 'bin' does not exist in ${input}`);
  }

  // inputFin

  const inputFin = inputBin || input;

  // config

  let config = argv.c || argv.config;

  if (inputJson && config) {
    throw wasReported('Specify either \'package.json\' or config. Not both');
  }

  // configJson

  let configJson = null;

  if (config) {
    config = path.resolve(config);
    if (!await exists(config)) {
      throw wasReported(`Config file ${config} does not exist`);
    }
    configJson = require(config); // may be either json or js
    if (!configJson.name && !configJson.files &&
        !configJson.dependencies && !configJson.pkg) { // package.json not detected
      configJson = { pkg: configJson };
    }
  }

  // output, outputDir

  let output = argv.o || argv.output;
  let outputDir = argv.outdir || argv['out-dir'];
  let autoOutput = false;

  if (output && outputDir) {
    throw wasReported('Specify either \'output\' or \'out-dir\'. Not both');
  }

  if (!output) {
    let name;
    if (inputJson) {
      name = inputJson.name;
      if (!name) {
        throw wasReported(`Property 'name' does not exist in ${argv._[0]}`);
      }
    } else
    if (configJson) {
      name = configJson.name;
    }
    if (!name) {
      name = path.basename(inputFin);
    }
    autoOutput = true;
    const ext = path.extname(name);
    output = name.slice(0, -ext.length || undefined);
    output = path.resolve(outputDir || '', output);
  }

  // targets

  const sTargets = argv.t || argv.target || argv.targets || '';
  if (typeof sTargets !== 'string') {
    throw wasReported(`Something is wrong near ${JSON.stringify(sTargets)}`);
  }

  let targets = parseTargets(
    sTargets.split(',').filter((t) => t)
  );

  if (!targets.length) {
    let jsonTargets;
    if (inputJson && inputJson.pkg) {
      jsonTargets = inputJson.pkg.targets;
    } else
    if (configJson && configJson.pkg) {
      jsonTargets = configJson.pkg.targets;
    }
    if (jsonTargets) {
      targets = parseTargets(jsonTargets);
    }
  }

  if (!targets.length) {
    if (!autoOutput) {
      targets = parseTargets([ 'host' ]);
      assert(targets.length === 1);
    } else {
      targets = parseTargets([ 'linux', 'macos', 'win' ]);
    }
    log.info('Targets not specified. Assuming:',
      `${targets.map(stringifyTarget).join(', ')}`);
  }

  // differentParts

  const different = differentParts(targets);

  // targets[].output

  if (targets.length === 1) {
    const target = targets[0];
    let file = output;
    if (target.platform === 'win' && autoOutput) file += '.exe';
    target.output = file;
  } else {
    for (const target of targets) {
      let file = stringifyTargetForOutput(output, target, different);
      if (target.platform === 'win') file += '.exe';
      target.output = file;
    }
  }

  // options

  let options = argv.options || '';
  options = options.split(',')
    .filter(option => option)
    .map(option => '--' + option);

  // check if input is going
  // to be overwritten by output

  for (const target of targets) {
    if (target.output === inputFin) {
      if (autoOutput) {
        target.output += '-' + target.platform;
      } else {
        throw wasReported(`Refusing to overwrite input ${inputFin}`);
      }
    }
  }

  // fetch targets

  for (const target of targets) {
    target.forceBuild = forceBuild;
    await needWithDryRun(target);
    const f = target.fabricator = fabricatorForTarget(target);
    f.forceBuild = forceBuild;
    await needWithDryRun(f);
  }

  if (dryRunResults.fetched && !dryRunResults.built) {
    log.info('Fetching base Node.js binaries to: ~/.pkg-cache');
  }

  for (const target of targets) {
    target.binaryPath = await needViaCache(target);
    const f = target.fabricator;
    f.binaryPath = await needViaCache(f);
    if (f.platform !== 'win') {
      await plusx(f.binaryPath);
    }
  }

  // tuple

  let tuple;

  if (configJson) {
    tuple = {
      config: configJson,
      base: path.dirname(config)
    };
  } else {
    tuple = {
      config: inputJson || {},
      base: path.dirname(input) // not `inputBin` because only `input`
    };                          // is the place for `inputJson`
  }

  // records

  const records = await walker({
    tuple, input: inputFin
  });

  const stripes = {};

  for (const target of targets) {
    const slash = target.platform === 'win' ? '\\' : '/';
    target.slash = slash;
    if (!stripes[slash]) {
      // TODO infos are shown twice (once for each slash)
      stripes[slash] = await packer({ records, slash });
    }
  }

  log.debug('Targets:', JSON.stringify(targets));

  for (const target of targets) {
    await mkdirp(path.dirname(target.output));
    await remove(target.output);
    await producer({ stripe: stripes[target.slash], options, target });
    if (target.platform !== 'win') {
      await plusx(target.output);
    }
  }
}
