import { IPC, IPC_PUSH } from '../../../shared/ipc';
import { PageHeader } from '../../components/layout/PageHeader';
import { Placeholder } from '../../components/shared/Placeholder';

/** PLACEHOLDER — replace this whole file. Owns `/approvals` and everything under it. */
export function ApprovalsScreen() {
  return (
    <>
      <PageHeader
        title="Approvals"
        description="Actions waiting on you, and the standing grants you have given."
      />
      <Placeholder
        filePath="src/renderer/features/approvals/ApprovalsScreen.tsx"
        summary="The approval card is the most important control in the product: plain language, the raw command on expand, three buttons."
        requirements={[
          'Card per pending approval: title, plain-language summary, tool name, and rawDetail/toolArguments behind a CollapsibleSection with CodeBlock.',
          'Three scopes ship from day one — once / run / always (APPROVAL_SCOPE_LABEL in lib/status.ts has the wording). Respect settings.approvals.allowAlwaysScope and defaultScope.',
          'Deny takes an optional reason.',
          'Resolve through useApprovalsStore().resolve — it is already optimistic and rolls back on failure. Do not call the channel directly.',
          'Second section: standing grants, with revoke.',
          'Oldest first. Keyboard: the queue should be answerable without the mouse.',
        ]}
        channels={[
          IPC.approvals.listPending,
          IPC.approvals.resolve,
          IPC.approvals.listGrants,
          IPC.approvals.revokeGrant,
        ]}
        pushChannels={[IPC_PUSH.approvalRequested, IPC_PUSH.approvalResolved]}
      />
    </>
  );
}

export default ApprovalsScreen;
