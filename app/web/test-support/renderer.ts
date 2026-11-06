/**
 * React, reached from the ROOT test suite.
 *
 * The tests live at the repository root; React and react-test-renderer live in
 * web/node_modules. Importing them from a root test file would resolve a
 * SECOND copy of React — or none at all — and a hook rendered by one copy of
 * React while another copy owns the dispatcher fails with "invalid hook call"
 * for reasons that have nothing to do with the code under test.
 *
 * Re-exporting from inside `web/` makes module resolution start here, so the
 * renderer and the components under test share one React. That is the whole
 * job of this file.
 *
 * It sits outside `web/src` deliberately: tsconfig only includes `src`, so
 * test scaffolding is not part of the app's typecheck or its bundle.
 */
import * as React from "react";

export { act, create } from "react-test-renderer";
export { createElement, useState } from "react";

/**
 * The components under test are .tsx, and the root test runner transforms them
 * with the CLASSIC JSX runtime — the emitted code is `React.createElement(…)`
 * against a free `React` binding that the source files, written for the
 * automatic runtime, never import. Publishing the SAME React instance as a
 * global satisfies that binding without changing app source or the server's
 * tsconfig to suit the tests.
 */
export function installReactGlobal(): void {
  (globalThis as Record<string, unknown>).React = React;
}
