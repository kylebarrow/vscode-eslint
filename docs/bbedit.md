# BBEdit diagnostics, quick fixes and formatting

This fork supports both LSP diagnostic modes. Clients advertising `textDocument.diagnostic` continue to use pull diagnostics. Other clients receive `textDocument/publishDiagnostics` notifications automatically; no BBEdit-specific switch is needed.

## Build

Use a Node.js version supported by the locked dependencies (tested with Node 24.22.2), and run these commands from this checkout:

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix server
npm run compile:server
npm test --prefix server
npm run lint --prefix server
```

This builds only the standalone server. It does not require VS Code or install the extension. The project being edited still needs its own ESLint installation, configuration and any referenced plugins. Only open projects whose ESLint configuration and plugins you trust: they execute locally in Node.js.

## Configure BBEdit

In Settings → Languages → Custom Settings, double-click **JavaScript**, then select **Server**:

- Enable language server.
- Command: the absolute path reported by `command -v node`.
- Arguments: `/absolute/path/to/vscode-eslint/server/out/eslintServer.js --stdio` (quote the script path if it contains spaces).
- Language ID: `javascript`.
- Configuration: `Default` is sufficient for diagnostics and quick fixes. For formatting, copy [BBEdit-ESLint.json](BBEdit-ESLint.json) into BBEdit’s `Language Servers/Configuration` folder and select it here.

This replaces the configured JavaScript language server; ESLint supplies lint diagnostics, not TypeScript-style completion or symbol navigation. To undo the setup, restore your previous command and arguments or remove the JavaScript custom setting if it was created solely for ESLint.

The standalone path probes whether ESLint can lint each file, resolves the most specific advertised workspace folder, and uses the existing ESLint working-directory/configuration discovery. Files outside advertised folders use their containing directory. Ignored or unsupported files produce no issues.

## Quick fixes and formatting

Right-click an underlined problem and choose **Code Actions** → **Fix this … problem**, or **Fix all auto-fixable problems**. The contextual menu works even when the editor sends no diagnostics with its request. Actions are scoped to the selected range or cursor location. Diagnostics refresh after an edit.

For **Text → Reformat Document**, enable `format` in the selected server configuration:

```json
{
  "initializationOptions": {
    "eslint": { "format": true }
  }
}
```

Formatting runs ESLint autofix using the edited project's rules, not BBEdit's tab/space preferences. It can change code as well as whitespace (for example, `var` to `const`); review the result as you would an ESLint `--fix` run. It does not save the document automatically. **Reformat Selection** is not advertised because this server has no range formatter.

For clients without dynamic formatter registration, the server advertises a static document formatter; individual requests still honor `format: false` and disabled validation. Clients supporting dynamic registration retain that path. Quick-fix commands use the workspace-edit representation advertised by the client, and stale cached fixes are rejected before sending edits. Clients without versioned workspace edits cannot guard against edits made after the server sends its apply-edit request.

## Save behavior

`run: "onSave"` runs diagnostics after saving; it does not apply fixes. `format: true` enables the explicit **Reformat Document** command, not automatic formatting on save.

In the captured BBEdit 16.1 session, the client advertised `synchronization.didSave` and `synchronization.willSave`, but not `synchronization.willSaveWaitUntil`. Saving sent `textDocument/willSave` followed by `textDocument/didSave`, without a formatting or fix-all request. This fork currently advertises `willSaveWaitUntil: false` and has no automatic save-fix handler.

Consequently, automatic fix-on-save is not supported by this BBEdit setup. An asynchronous `workspace/applyEdit` in response to a save notification cannot guarantee that fixes reach disk in that save. Use **Reformat Document** before saving. A separate, optional BBEdit attachment script would be needed to coordinate fixes with saving unless BBEdit adds the corresponding LSP support.

## Optional settings

Push clients request the `eslint` workspace configuration section for each document. They can also provide defaults in `initializationOptions.eslint`; workspace configuration takes precedence. These are the server's settings, not the VS Code extension's configuration schema: `validate` is `"on"`, `"off"` or `"probe"`, and `workingDirectory` is singular.

For example, put this JSON in a file in BBEdit's `Language Servers/Configuration` folder and select it in the Server tab:

```json
{
  "initializationOptions": {
    "eslint": {
      "validate": "probe",
      "run": "onType"
    }
  },
  "workspaceConfigurations": {
    "*": {
      "eslint": {
        "quiet": false
      }
    }
  }
}
```

Use `"run": "onSave"` to validate on open and save rather than on each edit. Use `"validate": "on"` to enforce linting and surface missing-library errors in the server log. For unusual project layouts, specify `"workingDirectory": { "directory": "/absolute/project/root" }` in the relevant workspace's settings. Avoid one fixed directory for unrelated projects.

The server revalidates open documents when the client sends configuration, workspace-folder or watched-file changes. This patch does not install filesystem watchers. If your editor does not send those notifications, restart the server after changing ESLint configuration or dependencies. Restarting also reloads configuration modules cached by Node.js.

See [Bare Bones' configuration documentation](https://hosting.barebones.com/support/bbedit/lsp-notes.html) for workspace-specific settings and `.BBEditLSPWorkspaceConfig.json`.

## Validation and limits

Tested with BBEdit 16.1 (16B26), Node 24.22.2 and the checkout's ESLint 10.9.1 on macOS:

1. Open `playgrounds/bbedit/sample.js`. Expect a `no-unused-vars` warning and a `no-undef` error.
2. Replace its contents with `export const answer = 42;`. The issues clear before saving.
3. Undo the replacement. Both issues return; save, close and reopen the file to confirm they still appear.

Quick-fix/formatting fixture: open `playgrounds/bbedit/fixes.js`. It intentionally uses `var`, double quotes and missing semicolons. Tested in BBEdit:

1. **Fix this no-var problem** changes `var` to `let`.
2. **Fix all auto-fixable problems** produces `const greeting = 'hello';` and `export { greeting };`, with zero diagnostics.
3. Reset the fixture, then **Text → Reformat Document** produces the same result and clears diagnostics.

The fixtures intentionally contain lint errors. Its local configuration uses the ESLint installed at the checkout root.

An additional fixture under `/tmp` received valid diagnostic notifications on the wire but did not display them in this BBEdit session. Use a normal project directory when reproducing; the cause of that path-specific behavior remains unconfirmed.

Automated stdio tests cover push and pull negotiation, edits, on-save mode, disabling validation, refresh notifications, optional diagnostic versions and clients without workspace configuration. Additional protocol tests cover empty diagnostic contexts, range scoping, legacy and versioned quick-fix edits, stale commands, source-fix-all edits, dynamic/static formatting and opt-out settings. Scheduler tests cover rapid edits and close/reopen while validation is running. ESLint operations are serialized to protect the process working directory during background validation.

Typing is debounced by 200 ms. Superseded results are discarded, and closing a document clears its diagnostics. The existing pull path and its configuration contract remain intact. Single quick fixes, fix-all and whole-document formatting have been qualified in BBEdit. Automatic fix-on-save is not supported by this BBEdit setup (see Save behavior above). Coexistence with another language server has not been qualified. Rule-documentation actions are omitted when the standalone client cannot open them. ESLint-specific status notifications may still appear as unhandled messages in verbose client logs.
