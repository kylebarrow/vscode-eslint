/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import { Diagnostic, PublishDiagnosticsParams, TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

type Reason = 'open' | 'change' | 'save' | 'refresh';
type Pending = { document: TextDocument; reason: Reason; timer?: ReturnType<typeof setTimeout> };

/** Debounce and serialize push validation, dropping results superseded by edits or close. */
export class PushDiagnostics {
	private readonly pending = new Map<string, Pending>();
	private queue: Promise<void> = Promise.resolve();

	/** Bind the document store, lint callback and protocol output. */
	constructor(
		private readonly documents: TextDocuments<TextDocument>,
		private readonly validate: (document: TextDocument, reason: Reason) => Promise<Diagnostic[] | undefined>,
		private readonly publish: (params: PublishDiagnosticsParams) => Promise<void>,
		private readonly reportError: (error: unknown) => void,
		private readonly delay = 200
	) {}

	/** Schedule a snapshot; opening a document also emits a content-change event. */
	public schedule(document: TextDocument, reason: Reason): void {
		const previous = this.pending.get(document.uri);
		if (previous?.timer !== undefined) {
			clearTimeout(previous.timer);
			if (reason === 'change' && (previous.reason === 'open' || previous.reason === 'refresh')) {
				reason = previous.reason;
			}
		}
		const job: Pending = {
			document: TextDocument.create(document.uri, document.languageId, document.version, document.getText()),
			reason
		};
		this.pending.set(document.uri, job);
		job.timer = setTimeout(() => {
			job.timer = undefined;
			this.queue = this.queue.then(() => this.run(job)).catch(this.reportError);
		}, this.delay);
	}

	/** Clear diagnostics and invalidate both queued and running work for a closed document. */
	public close(uri: string): void {
		clearTimeout(this.pending.get(uri)?.timer);
		this.pending.delete(uri);
		void this.publish({ uri, diagnostics: [] }).catch(this.reportError);
	}

	/** Cancel pending timers and prevent in-flight results from being published on shutdown. */
	public dispose(): void {
		for (const job of this.pending.values()) {
			clearTimeout(job.timer);
		}
		this.pending.clear();
	}

	/** Validate only the latest snapshot and publish only if it is still current. */
	private async run(job: Pending): Promise<void> {
		const { uri, version } = job.document;
		if (this.pending.get(uri) !== job) {
			return;
		}
		let diagnostics: Diagnostic[] | undefined;
		try {
			diagnostics = await this.validate(job.document, job.reason);
		} catch (error) {
			this.reportError(error);
			diagnostics = [];
		}
		if (this.pending.get(uri) !== job || this.documents.get(uri)?.version !== version) {
			return;
		}
		this.pending.delete(uri);
		if (diagnostics !== undefined) {
			await this.publish({ uri, version, diagnostics });
		}
	}
}
