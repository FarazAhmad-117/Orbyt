-- RLS for channel accounts (helper from 0005_crm_rls.sql). Enabled but NOT forced: the inbound
-- webhook looks the account up by its unguessable token before the workspace is known.
SELECT app_enable_workspace_rls('channel_accounts', false);
