# Earlier hosted Claude migration history

These snapshots and journal preserve the hosted Claude branch history before
merging upstream main. The original SQL files `0018_remote_claude.sql` and
`0019_far_tana_nile.sql` remain available but are outside the active journal.
Upstream used 0018 for chat and reserved 0019 for deferred Figma support.

The active journal preserves upstream history and appends `0028_remote_claude`.
That migration adds Claude preference columns only when absent and ensures the
chat table exists for branch databases whose migration timestamp skipped
upstream's earlier chat migration. Existing preferences and auth state are kept.
This directory is archival and is outside Drizzle's active snapshot chain.
