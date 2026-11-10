/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as assert from 'node:assert/strict';
import { it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PublishDiagnosticsParams, TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { PushDiagnostics } from '../pushDiagnostics';

void it('drops a running result after an edit, debounces changes and clears on close', async () => {
	let current: TextDocument | undefined = TextDocument.create('file:///test.js', 'javascript', 1, 'old');
	const store = { get: () => current } as unknown as TextDocuments<TextDocument>;
	const publications: PublishDiagnosticsParams[] = [];
	const validated: number[] = [];
	let release!: () => void;
	const blocked = new Promise<void>(resolve => { release = resolve; });
	const scheduler = new PushDiagnostics(store, async document => {
		validated.push(document.version);
		if (document.version === 1) {
			await blocked;
		}
		return [];
	}, async params => { publications.push(params); }, error => { throw error; }, 1);
	try {
		scheduler.schedule(current, 'open');
		await delay(20);
		current = TextDocument.create(current.uri, 'javascript', 2, 'intermediate');
		scheduler.schedule(current, 'change');
		current = TextDocument.create(current.uri, 'javascript', 3, 'latest');
		scheduler.schedule(current, 'change');
		release();
		await delay(30);
		assert.deepEqual(validated, [1, 3]);
		assert.deepEqual(publications.map(item => item.version), [3]);
		scheduler.schedule(current, 'change');
		scheduler.close(current.uri);
		current = undefined;
		await delay(20);
		assert.equal(publications.length, 2);
		assert.deepEqual(publications[1].diagnostics, []);
		assert.deepEqual(validated, [1, 3]);
	} finally {
		release();
		scheduler.dispose();
	}
});

void it('does not publish in-flight validation after close and reopen at the same version', async () => {
	const document = TextDocument.create('file:///test.js', 'javascript', 1, 'content');
	const store = { get: () => document } as unknown as TextDocuments<TextDocument>;
	const publications: PublishDiagnosticsParams[] = [];
	let release!: () => void;
	const blocked = new Promise<void>(resolve => { release = resolve; });
	const scheduler = new PushDiagnostics(store, async () => { await blocked; return []; }, async params => { publications.push(params); }, error => { throw error; }, 1);
	try {
		scheduler.schedule(document, 'open');
		await delay(20);
		scheduler.close(document.uri);
		scheduler.schedule(document, 'open');
		release();
		await delay(30);
		assert.deepEqual(publications.map(item => item.version), [undefined, 1]);
	} finally {
		release();
		scheduler.dispose();
	}
});
