/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

/* @flow */

import { Realm } from "./realm.js";
import initializeSingletons from "./initialize-singletons.js";
import { initialize as initializeIntrinsics } from "./intrinsics/index.js";
import initializeGlobal from "./intrinsics/ecma262/global.js";
import type { RealmOptions } from "./options.js";
import * as evaluators from "./evaluators/index.js";
import * as partialEvaluators from "./partial-evaluators/index.js";
import { Environment } from "./singletons.js";
import { ObjectValue } from "./values/index.js";
import { DebugServer } from "./debugger/Debugger.js";
import type { DebugChannel } from "./debugger/channel/DebugChannel.js";
import simplifyAndRefineAbstractValue from "./utils/simplifier.js";

export default function(opts: RealmOptions = {}, debugChannel: void | DebugChannel = undefined): Realm {
  initializeSingletons();
  let r = new Realm(opts);
  if (debugChannel) {
    if (debugChannel.debuggerIsAttached()) {
      r.debuggerInstance = new DebugServer(debugChannel, r);
    }
  }

  let i = r.intrinsics;
  initializeIntrinsics(i, r);
  // TODO: Find a way to let different environments initialize their own global
  // object for special magic host objects such as the window object in the DOM.
  r.$GlobalObject = new ObjectValue(r, i.ObjectPrototype, "global");
  initializeGlobal(r);
  for (let name in evaluators) r.evaluators[name] = evaluators[name];
  for (let name in partialEvaluators) r.partialEvaluators[name] = partialEvaluators[name];
  r.simplifyAndRefineAbstractValue = simplifyAndRefineAbstractValue.bind(null, r, false);
  r.simplifyAndRefineAbstractCondition = simplifyAndRefineAbstractValue.bind(null, r, true);
  r.$GlobalEnv = Environment.NewGlobalEnvironment(r, r.$GlobalObject, r.$GlobalObject);
  return r;
}
