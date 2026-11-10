# Managed company workspaces

An instance operator can bind each dedicated bot account to one private workspace
using `MANAGED_COMPANY_WORKSPACES` in the server environment:

```sh
MANAGED_COMPANY_WORKSPACES='[{"workspaceId":"workspace-id","botUserId":"bot-user-id"}]'
```

Provision the workspace, human audience, non-admin bot account and bot agent key
through the normal APIs first. Remove the bot's generated personal welcome canvas
using its owner account. The operator then configures these nonsecret IDs and
restarts the server. `get_profile` reports the bot's `managed_workspace_id` so
connection setup can verify the applied binding. Keep agent keys in the existing
credential store; this setting contains no credentials.

The JSON accepts at most 128 unique workspace/bot pairs, 64 KiB, canonical ASCII
IDs of at most 128 characters, and no unknown properties. Before listening the
server checks that users and workspaces exist, bots are not instance admins or
workspace owners/admins, bots have no foreign workspace memberships, unrelated
personal ownership or direct invitations, and company canvases have no public
links or Community publication. Invalid setup stops startup without repairing
data. A deliberately removed bot membership remains removed across restart.

Each company canvas requires current workspace membership, including for its
owner and directly invited users. Workspace members can edit all its canvases.
An ordinary workspace owner cannot rebind or promote a managed bot, invite
another company's bot, detach company canvases, delete the configured workspace,
or enable public sharing or Community publication. Live delivery checks current
membership before every broadcast. Already delivered content cannot be recalled.
Humans can deliberately belong to multiple workspaces without merging bot
identities or credentials. Invite only the intended audience.

Design-sync key minting, listing and all ingest are disabled for company canvases.
Previously minted or retained keys remain inactive, including when their creator
is still a member and after restart. Design sync on unmanaged canvases is unchanged.

The instance/database operator remains trusted, including the existing admin
impersonation tools and deliberate configuration/restart operations. Removing a
binding is an operator deprovisioning decision that removes these restrictions;
ordinary users cannot change the setting. This policy uses the existing single
server membership authority and does not introduce multi-instance consistency.

Workspace checks alone do not protect every uploaded asset or rendered-image
URL. Use synthetic content until the separate private-media work is verified.
