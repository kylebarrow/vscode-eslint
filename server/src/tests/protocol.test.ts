/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { it, TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, InitializeResult, PublishDiagnosticsParams, FullDocumentDiagnosticReport, CodeAction, WorkspaceEdit, TextEdit, TextDocumentEdit } from 'vscode-languageserver/node';

/** Start the real server over stdio against an isolated ESLint project. */
async function start(t: TestContext, pull = false, configurationSupport = true, refreshSupport = false, versionSupport = true, documentChanges = false, dynamicFormatting = false) {
	const directory = await mkdtemp(path.join(tmpdir(), 'eslint-lsp-test-'));
	await symlink(path.resolve(__dirname, '../../..', 'node_modules'), path.join(directory, 'node_modules'), 'dir');
	await writeFile(path.join(directory, 'eslint.config.mjs'), 'export default [{ rules: { \'no-undef\': \'error\' } }];\n');
	const uri = pathToFileURL(path.join(directory, 'sample.js')).href;
	const child = spawn(process.execPath, [path.resolve(__dirname, '../eslintServer.js'), '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
	const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
	const published: PublishDiagnosticsParams[] = [];
	const sections: string[] = [];
	let settings: object = { validate: 'on' };
	let refreshes = 0;
	const applied: WorkspaceEdit[] = [];
	const registrations: { method: string }[] = [];
	connection.onRequest('workspace/applyEdit', (params: { edit: WorkspaceEdit }) => { applied.push(params.edit); return { applied: true }; });
	connection.onRequest('client/registerCapability', (params: { registrations: { method: string }[] }) => { registrations.push(...params.registrations); return null; });
	connection.onRequest('workspace/configuration', (params: { items: { section: string }[] }) => params.items.map(item => {
		sections.push(item.section);
		return settings;
	}));
	connection.onRequest('workspace/diagnostic/refresh', () => { refreshes++; return null; });
	connection.onNotification('textDocument/publishDiagnostics', (params: PublishDiagnosticsParams) => { published.push(params); });
	connection.onNotification(() => {});
	connection.listen();
	t.after(async () => {
		connection.dispose();
		child.kill();
		await rm(directory, { recursive: true, force: true });
	});
	const initialized = await connection.sendRequest<InitializeResult>('initialize', {
		processId: process.pid,
		rootUri: pathToFileURL(directory).href,
		capabilities: {
			workspace: { configuration: configurationSupport, diagnostics: { refreshSupport }, applyEdit: true, workspaceEdit: { documentChanges } },
			textDocument: {
				...(pull ? { diagnostic: {} } : { publishDiagnostics: { versionSupport } }),
				formatting: { dynamicRegistration: dynamicFormatting },
				codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix', 'source'] } } }
			}
		}
	});
	await connection.sendNotification('initialized', {});
	return { connection, initialized, published, sections, uri, directory, applied, registrations,
		setSettings: (value: object) => { settings = value; }, refreshes: () => refreshes };
}

/** Wait for a protocol condition with a bounded timeout. */
async function until(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (condition()) {
			return;
		}
		await delay(50);
	}
	assert.fail('Timed out waiting for protocol result');
}

void it('pushes open/edit diagnostics, refreshes settings, and clears on close', { timeout: 15000 }, async t => {
	const server = await start(t);
	const { connection, uri, published } = server;
	assert.equal(server.initialized.capabilities.diagnosticProvider, undefined);
	await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'javascript', version: 1, text: 'missing();' } });
	await until(() => published.length === 1);
	assert.equal(published[0].diagnostics[0].code, 'no-undef');
	assert.deepEqual(server.sections, ['eslint']);
	await connection.sendNotification('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'const answer = 42;' }] });
	await until(() => published.length === 2);
	assert.equal(published[1].version, 2);
	assert.deepEqual(published[1].diagnostics, []);
	await connection.sendNotification('textDocument/didChange', { textDocument: { uri, version: 3 }, contentChanges: [{ text: 'missing();' }] });
	await until(() => published.length === 3);
	server.setSettings({ validate: 'off' });
	await connection.sendNotification('workspace/didChangeConfiguration', { settings: {} });
	await until(() => published.length === 4);
	assert.deepEqual(published[3].diagnostics, []);
	await connection.sendNotification('textDocument/didClose', { textDocument: { uri } });
	await until(() => published.length === 5);
	assert.deepEqual(published[4].diagnostics, []);
	assert.equal(server.refreshes(), 0);
});

void it('honors onSave and revalidates watched configuration changes', { timeout: 15000 }, async t => {
	const server = await start(t);
	server.setSettings({ validate: 'on', run: 'onSave' });
	const { connection, uri, published } = server;
	await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'javascript', version: 1, text: 'missing();' } });
	await until(() => published.length === 1);
	await connection.sendNotification('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'const answer = 42;' }] });
	await delay(500);
	assert.equal(published.length, 1);
	await connection.sendNotification('textDocument/didSave', { textDocument: { uri } });
	await until(() => published.length === 2);
	assert.deepEqual(published[1].diagnostics, []);
	await connection.sendNotification('workspace/didChangeWatchedFiles', { changes: [{ uri: pathToFileURL(path.join(server.directory, 'eslint.config.mjs')).href, type: 2 }] });
	await until(() => published.length === 3);
	assert.equal(server.refreshes(), 0);
});

void it('uses probing defaults when workspace configuration is unsupported', { timeout: 15000 }, async t => {
	const server = await start(t, false, false);
	await server.connection.sendNotification('textDocument/didOpen', { textDocument: { uri: server.uri, languageId: 'javascript', version: 1, text: 'missing();' } });
	await until(() => server.published.length === 1);
	assert.equal(server.published[0].diagnostics[0].code, 'no-undef');
	assert.deepEqual(server.sections, []);
});

for (const refreshSupport of [false, true]) {
	void it(`preserves pull diagnostics (refresh support: ${refreshSupport})`, { timeout: 15000 }, async t => {
		const server = await start(t, true, true, refreshSupport);
		assert.ok(server.initialized.capabilities.diagnosticProvider);
		await server.connection.sendNotification('textDocument/didOpen', { textDocument: { uri: server.uri, languageId: 'javascript', version: 1, text: 'missing();' } });
		const report = await server.connection.sendRequest<FullDocumentDiagnosticReport>('textDocument/diagnostic', { textDocument: { uri: server.uri } });
		assert.equal(report.items[0].code, 'no-undef');
		assert.deepEqual(server.sections, ['']);
		await server.connection.sendNotification('workspace/didChangeConfiguration', { settings: {} });
		await delay(350);
		assert.equal(server.refreshes(), refreshSupport ? 1 : 0);
		assert.deepEqual(server.published, []);
	});
}

void it('omits diagnostic versions for clients such as BBEdit without version support', { timeout: 15000 }, async t => {
	const server = await start(t, false, true, false, false);
	await server.connection.sendNotification('textDocument/didOpen', { textDocument: { uri: server.uri, languageId: 'javascript', version: 1, text: 'missing();' } });
	await until(() => server.published.length === 1);
	assert.equal(server.published[0].version, undefined);
	assert.equal(server.published[0].diagnostics[0].code, 'no-undef');
});

/** Open an intentionally fixable document using the project's own rules. */
async function openFixable(server: Awaited<ReturnType<typeof start>>, format = false): Promise<string> {
	server.setSettings({ validate: 'on', format, options: { overrideConfig: { rules: { 'no-var': 'error', 'prefer-const': 'error' } } } });
	const text = 'var answer = 42;\nexport { answer };\n';
	await server.connection.sendNotification('textDocument/didOpen', { textDocument: { uri: server.uri, languageId: 'javascript', version: 1, text } });
	await until(() => server.published.length === 1);
	return text;
}

/** Request actions with BBEdit's empty diagnostic context at a selected range. */
async function actionsAt(server: Awaited<ReturnType<typeof start>>, line = 0, only?: string[]): Promise<CodeAction[]> {
	return server.connection.sendRequest('textDocument/codeAction', {
		textDocument: { uri: server.uri },
		range: { start: { line, character: 0 }, end: { line, character: 3 } },
		context: { diagnostics: [], ...(only ? { only } : {}) }
	});
}

for (const documentChanges of [false, true]) {
	void it(`applies empty-context quick fixes using supported edits (documentChanges: ${documentChanges})`, { timeout: 15000 }, async t => {
		const server = await start(t, false, true, false, true, documentChanges);
		const text = await openFixable(server);
		assert.deepEqual(await actionsAt(server, 1), []);
		const actions = await actionsAt(server);
		const fix = actions.find(action => action.command?.command === 'eslint.applySingleFix');
		assert.ok(fix?.command);
		assert.ok(!actions.some(action => action.command?.command === 'eslint.openRuleDoc'));
		await server.connection.sendRequest('workspace/executeCommand', fix.command);
		assert.equal(server.applied.length, 1);
		const edit = server.applied[0];
		assert.equal(edit.documentChanges !== undefined, documentChanges);
		const edits = documentChanges ? (edit.documentChanges![0] as TextDocumentEdit).edits as TextEdit[] : edit.changes![server.uri];
		assert.equal(TextDocument.applyEdits(TextDocument.create(server.uri, 'javascript', 1, text), edits), text.replace('var', 'let'));
		await server.connection.sendNotification('textDocument/didChange', { textDocument: { uri: server.uri, version: 2 }, contentChanges: [{ text: text.replace('var', 'let') }] });
		await server.connection.sendRequest('workspace/executeCommand', fix.command);
		assert.equal(server.applied.length, 1, 'stale commands must not apply');
	});
}

void it('returns legacy source-fix-all edits and ignores stale cached diagnostics', { timeout: 15000 }, async t => {
	const server = await start(t);
	const text = await openFixable(server);
	const actions = await actionsAt(server, 0, ['source.fixAll.eslint']);
	assert.ok(actions[0].edit?.changes);
	assert.equal(actions[0].edit?.documentChanges, undefined);
	assert.equal(TextDocument.applyEdits(TextDocument.create(server.uri, 'javascript', 1, text), actions[0].edit!.changes![server.uri]), text.replace('var', 'const'));
	await server.connection.sendNotification('textDocument/didChange', { textDocument: { uri: server.uri, version: 2 }, contentChanges: [{ text: 'export const answer = 42;\n' }] });
	assert.deepEqual(await actionsAt(server), []);
});

for (const dynamicFormatting of [false, true]) {
	void it(`formats with supported registration (dynamic: ${dynamicFormatting})`, { timeout: 15000 }, async t => {
		const server = await start(t, false, true, false, true, false, dynamicFormatting);
		const text = await openFixable(server, true);
		assert.equal(server.initialized.capabilities.documentFormattingProvider, dynamicFormatting ? undefined : true);
		assert.equal(server.registrations.some(item => item.method === 'textDocument/formatting'), dynamicFormatting);
		const edits = await server.connection.sendRequest<TextEdit[]>('textDocument/formatting', { textDocument: { uri: server.uri }, options: { tabSize: 4, insertSpaces: false } });
		assert.equal(TextDocument.applyEdits(TextDocument.create(server.uri, 'javascript', 1, text), edits), text.replace('var', 'const'));
		server.setSettings({ validate: 'on', format: false });
		await server.connection.sendNotification('workspace/didChangeConfiguration', { settings: {} });
		const disabled = await server.connection.sendRequest<TextEdit[]>('textDocument/formatting', { textDocument: { uri: server.uri }, options: { tabSize: 4, insertSpaces: false } });
		assert.deepEqual(disabled, []);
	});
}
