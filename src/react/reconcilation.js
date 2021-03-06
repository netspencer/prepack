/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

/* @flow */

import { Realm, type Effects } from "../realm.js";
import { ModuleTracer } from "../serializer/modules.js";
import {
  ECMAScriptSourceFunctionValue,
  Value,
  UndefinedValue,
  StringValue,
  NumberValue,
  BooleanValue,
  NullValue,
  AbstractValue,
  ArrayValue,
  ObjectValue,
  AbstractObjectValue,
} from "../values/index.js";
import { ReactStatistics, type ReactSerializerState } from "../serializer/types.js";
import { isReactElement, valueIsClassComponent, mapOverArrayValue } from "./utils";
import { Get } from "../methods/index.js";
import invariant from "../invariant.js";
import { CompilerDiagnostic, FatalError } from "../errors.js";
import { BranchState, type BranchStatusEnum } from "./branching.js";
import { getInitialProps, getInitialContext, createClassInstance } from "./components.js";

// ExpectedBailOut is like an error, that gets thrown during the reconcilation phase
// allowing the reconcilation to continue on other branches of the tree, the message
// given to ExpectedBailOut will be assigned to the value.$BailOutReason property and serialized
// as a comment in the output source to give the user hints as to what they need to do
// to fix the bail-out case
export class ExpectedBailOut {
  message: string;
  constructor(message: string) {
    this.message = message;
  }
}

export class Reconciler {
  constructor(
    realm: Realm,
    moduleTracer: ModuleTracer,
    statistics: ReactStatistics,
    reactSerializerState: ReactSerializerState
  ) {
    this.realm = realm;
    this.moduleTracer = moduleTracer;
    this.statistics = statistics;
    this.reactSerializerState = reactSerializerState;
  }

  realm: Realm;
  moduleTracer: ModuleTracer;
  statistics: ReactStatistics;
  reactSerializerState: ReactSerializerState;

  render(componentType: ECMAScriptSourceFunctionValue): Effects {
    return this.realm.wrapInGlobalEnv(() =>
      // TODO: (sebmarkbage): You could use the return value of this to detect if there are any mutations on objects other
      // than newly created ones. Then log those to the error logger. That'll help us track violations in
      // components. :)
      this.realm.evaluateForEffects(() => {
        // initialProps and initialContext are created from Flow types from:
        // - if a functional component, the 1st and 2nd paramater of function
        // - if a class component, use this.props and this.context
        // if there are no Flow types for props or context, we will throw a
        // FatalError, unless it's a functional component that has no paramater
        // i.e let MyComponent = () => <div>Hello world</div>
        try {
          let initialProps = getInitialProps(this.realm, componentType);
          let initialContext = getInitialContext(this.realm, componentType);
          let { result } = this._renderComponent(componentType, initialProps, initialContext, "ROOT", null);
          this.statistics.optimizedTrees++;
          return result;
        } catch (error) {
          // if there was a bail-out on the root component in this reconcilation process, then this
          // should be an invariant as the user has explicitly asked for this component to get folded
          if (error instanceof ExpectedBailOut) {
            let diagnostic = new CompilerDiagnostic(
              `__registerReactComponentRoot() failed due to - ${error.message}`,
              this.realm.currentLocation,
              "PP0019",
              "FatalError"
            );
            this.realm.handleError(diagnostic);
            throw new FatalError();
          }
          throw error;
        }
      })
    );
  }
  _renderComponent(
    componentType: ECMAScriptSourceFunctionValue,
    props: ObjectValue | AbstractObjectValue,
    context: ObjectValue | AbstractObjectValue,
    branchStatus: BranchStatusEnum,
    branchState: BranchState | null
  ) {
    let value;
    let childContext = context;
    if (valueIsClassComponent(this.realm, componentType)) {
      if (branchStatus !== "ROOT") {
        throw new ExpectedBailOut("only class components at the root of __registerReactComponentRoot() are supported");
      }
      // create a new instance of this React class component
      let instance = createClassInstance(this.realm, componentType, props, context);
      // get the "render" method off the instance
      let renderMethod = Get(this.realm, instance, "render");
      invariant(
        renderMethod instanceof ECMAScriptSourceFunctionValue && renderMethod.$Call,
        "Expected render method to be a FunctionValue with $Call method"
      );
      // the render method doesn't have any arguments, so we just assign the context of "this" to be the instance
      value = renderMethod.$Call(instance, []);
    } else {
      invariant(componentType.$Call, "Expected componentType to be a FunctionValue with $Call method");
      value = componentType.$Call(this.realm.intrinsics.undefined, [props, context]);
    }
    return {
      result: this._resolveDeeply(value, context, branchStatus === "ROOT" ? "NO_BRANCH" : branchStatus, branchState),
      childContext,
    };
  }
  _resolveDeeply(
    value: Value,
    context: ObjectValue | AbstractObjectValue,
    branchStatus: BranchStatusEnum,
    branchState: BranchState | null
  ) {
    if (
      value instanceof StringValue ||
      value instanceof NumberValue ||
      value instanceof BooleanValue ||
      value instanceof NullValue ||
      value instanceof UndefinedValue
    ) {
      // terminal values
      return value;
    } else if (value instanceof AbstractValue) {
      let length = value.args.length;
      if (length > 0) {
        let newBranchState = new BranchState();
        // TODO investigate what other kinds than "conditional" might be safe to deeply resolve
        for (let i = 0; i < length; i++) {
          value.args[i] = this._resolveDeeply(value.args[i], context, "NEW_BRANCH", newBranchState);
        }
        newBranchState.applyBranchedLogic(this.realm, this.reactSerializerState);
      }
      return value;
    }
    // TODO investigate what about other iterables type objects
    if (value instanceof ArrayValue) {
      this._resolveFragment(value, context, branchStatus, branchState);
      return value;
    }
    if (value instanceof ObjectValue && isReactElement(value)) {
      // we call value reactElement, to make it clearer what we're dealing with in this block
      let reactElement = value;
      let typeValue = Get(this.realm, reactElement, "type");
      let propsValue = Get(this.realm, reactElement, "props");
      let refValue = Get(this.realm, reactElement, "ref");
      if (typeValue instanceof StringValue) {
        // terminal host component. Start evaluating its children.
        if (propsValue instanceof ObjectValue) {
          let childrenProperty = propsValue.properties.get("children");
          if (childrenProperty) {
            let childrenPropertyDescriptor = childrenProperty.descriptor;
            // if the descriptor is undefined, the property is likely deleted, if it exists
            // proceed to resolve the children
            if (childrenPropertyDescriptor !== undefined) {
              let childrenPropertyValue = childrenPropertyDescriptor.value;
              invariant(childrenPropertyValue instanceof Value, `Bad "children" prop passed in JSXElement`);
              let resolvedChildren = this._resolveDeeply(childrenPropertyValue, context, branchStatus, branchState);
              childrenPropertyDescriptor.value = resolvedChildren;
            }
          }
        }
        return reactElement;
      }
      // we do not support "ref" on <Component /> ReactElements
      if (!(refValue instanceof NullValue)) {
        this._assignBailOutMessage(reactElement, `Bail-out: refs are not supported on <Components />`);
        return reactElement;
      }
      if (!(propsValue instanceof ObjectValue || propsValue instanceof AbstractObjectValue)) {
        this._assignBailOutMessage(
          reactElement,
          `Bail-out: props on <Component /> was not not an ObjectValue or an AbstractValue`
        );
        return reactElement;
      }
      if (!(typeValue instanceof ECMAScriptSourceFunctionValue)) {
        this._assignBailOutMessage(
          reactElement,
          `Bail-out: type on <Component /> was not a ECMAScriptSourceFunctionValue`
        );
        return reactElement;
      }
      try {
        let { result } = this._renderComponent(
          typeValue,
          propsValue,
          context,
          branchStatus === "NEW_BRANCH" ? "BRANCH" : branchStatus,
          null
        );
        if (result instanceof UndefinedValue) {
          this._assignBailOutMessage(reactElement, `Bail-out: undefined was returned from render`);
          if (branchStatus === "NEW_BRANCH" && branchState) {
            return branchState.captureBranchedValue(typeValue, reactElement);
          }
          return reactElement;
        }
        this.statistics.inlinedComponents++;
        if (branchStatus === "NEW_BRANCH" && branchState) {
          return branchState.captureBranchedValue(typeValue, result);
        }
        return result;
      } catch (error) {
        // assign a bail out message
        if (error instanceof ExpectedBailOut) {
          this._assignBailOutMessage(reactElement, "Bail-out: " + error.message);
        } else if (error instanceof FatalError) {
          this._assignBailOutMessage(reactElement, "Evaluation bail-out");
        } else {
          throw error;
        }
        // a child component bailed out during component folding, so return the function value and continue
        if (branchStatus === "NEW_BRANCH" && branchState) {
          return branchState.captureBranchedValue(typeValue, reactElement);
        }
        return reactElement;
      }
    } else {
      throw new ExpectedBailOut("unsupported value type during reconcilation");
    }
  }
  _assignBailOutMessage(reactElement: ObjectValue, message: string): void {
    // $BailOutReason is a field on ObjectValue that allows us to specify a message
    // that gets serialized as a comment node during the ReactElement serialization stage
    if (reactElement.$BailOutReason !== undefined) {
      // merge bail out messages if one already exists
      reactElement.$BailOutReason += `, ${message}`;
    } else {
      reactElement.$BailOutReason = message;
    }
  }
  _resolveFragment(
    arrayValue: ArrayValue,
    context: ObjectValue | AbstractObjectValue,
    branchStatus: BranchStatusEnum,
    branchState: BranchState | null
  ) {
    mapOverArrayValue(this.realm, arrayValue, (elementValue, elementPropertyDescriptor) => {
      elementPropertyDescriptor.value = this._resolveDeeply(elementValue, context, branchStatus, branchState);
    });
  }
}
