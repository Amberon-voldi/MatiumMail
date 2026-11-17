-- Audit log is append-only: any UPDATE or DELETE on `audit_logs` is rejected
-- by the database itself, whatever the application does.
-- (MilesWeb shared hosting grants TRIGGER on the app database; per-table
-- REVOKEs are not available there, so triggers are the enforcement mechanism.)

CREATE TRIGGER `audit_logs_no_update`
BEFORE UPDATE ON `audit_logs`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only';

CREATE TRIGGER `audit_logs_no_delete`
BEFORE DELETE ON `audit_logs`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only';
