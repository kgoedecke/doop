# Hosted Claude runtime

`src/cantelop.ts` is Doop's single Cantelop App definition. It declares the SDK's
Claude runtime, native authentication provider and Docker image. `cantelop.json`
points the CLI to this definition. The service shares Doop's Bun workspace and
SDK installation but deploys independently.

See the [setup and deployment guide](../README.md#set-up-your-own-hosted-claude-service)
for requirements, environment variables, build commands and local development.

The SDK owns Claude execution, durable queues, native login and output decoding.
Doop owns browser authorization, user Workspace selection and task-scoped MCP
access. Stable tool restrictions live in the App definition; model, prompt and
MCP credentials are passed in each task's dispatch settings.

The CLI writes the backend client to `.cantelop/client`. Doop imports it directly;
its runtime identity must match the deployed service. CI builds the service once
and smoke-tests the resulting image. Root integration tests cover the generated
client, user isolation, MCP authorization, cancellation and login behavior.
