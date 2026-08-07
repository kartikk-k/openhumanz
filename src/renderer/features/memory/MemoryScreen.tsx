import { IPC, IPC_PUSH } from '../../../shared/ipc';
import { PageHeader } from '../../components/layout/PageHeader';
import { Placeholder } from '../../components/shared/Placeholder';

/** PLACEHOLDER — replace this whole file. Owns `/memory` and everything under it. */
export function MemoryScreen() {
  return (
    <>
      <PageHeader
        title="Memory"
        description="The vault, as files — because it is files."
      />
      <Placeholder
        filePath="src/renderer/features/memory/MemoryScreen.tsx"
        summary="A file browser over the Markdown vault, plus full-text search. Every retrieved chunk shows provenance: document path, heading and line range."
        requirements={[
          'Tree or path-prefix list on the left, document content on the right.',
          'Search results are chunks, not documents — show snippet, docPath, heading and startLine/endLine on every hit.',
          'CodeBlock with showLineNumbers + startLine renders a chunk with its real line numbers.',
          'Surface the index status (docCount, chunkCount, indexing, vaultPath) and offer reindex.',
          'Search is FTS4, so a snippet arrives pre-marked — render it as plain text, never as HTML.',
        ]}
        channels={[
          IPC.memory.search,
          IPC.memory.get,
          IPC.memory.list,
          IPC.memory.write,
          IPC.memory.status,
          IPC.memory.reindex,
        ]}
        pushChannels={[IPC_PUSH.memoryIndexed]}
      />
    </>
  );
}

export default MemoryScreen;
