-- CreateTable
CREATE TABLE `organizations` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `organizations_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `users` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `email` VARCHAR(320) NOT NULL,
    `display_name` VARCHAR(191) NULL,
    `role` ENUM('OWNER', 'ADMIN', 'MEMBER') NOT NULL DEFAULT 'MEMBER',
    `status` ENUM('ACTIVE', 'SUSPENDED') NOT NULL DEFAULT 'ACTIVE',
    `totp_secret_enc` VARBINARY(512) NULL,
    `totp_enabled_at` DATETIME(3) NULL,
    `preferences` JSON NOT NULL,
    `last_login_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `users_email_key`(`email`),
    INDEX `users_organization_id_idx`(`organization_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sessions` (
    `id` CHAR(64) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `active_mailbox_id` CHAR(36) NULL,
    `mfa_verified_at` DATETIME(3) NULL,
    `ip_address` VARCHAR(191) NULL,
    `user_agent` VARCHAR(512) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NOT NULL,
    `absolute_expires_at` DATETIME(3) NOT NULL,

    INDEX `sessions_user_id_idx`(`user_id`),
    INDEX `sessions_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `mail_server_profiles` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL DEFAULT 'generic-imap',
    `imap_host` VARCHAR(191) NOT NULL,
    `imap_port` INTEGER NOT NULL,
    `imap_security` ENUM('TLS', 'STARTTLS') NOT NULL,
    `smtp_host` VARCHAR(191) NOT NULL,
    `smtp_port` INTEGER NOT NULL,
    `smtp_security` ENUM('TLS', 'STARTTLS') NOT NULL,
    `tls_servername` VARCHAR(191) NULL,
    `max_connections_per_mailbox` INTEGER NOT NULL DEFAULT 3,
    `smtp_max_per_hour` INTEGER NULL,
    `capabilities` JSON NULL,
    `verified_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `domains` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `server_profile_id` CHAR(36) NOT NULL,
    `name` VARCHAR(253) NOT NULL,
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `auto_provision` BOOLEAN NOT NULL DEFAULT false,
    `default_quota_bytes` BIGINT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `domains_name_key`(`name`),
    INDEX `domains_organization_id_idx`(`organization_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `mailboxes` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `domain_id` CHAR(36) NOT NULL,
    `address` VARCHAR(320) NOT NULL,
    `display_name` VARCHAR(191) NULL,
    `status` ENUM('PENDING_VERIFICATION', 'ACTIVE', 'NEEDS_REAUTH', 'ERROR', 'DISABLED') NOT NULL DEFAULT 'PENDING_VERIFICATION',
    `status_reason` TEXT NULL,
    `settings` JSON NOT NULL,
    `quota_used_bytes` BIGINT NULL,
    `quota_limit_bytes` BIGINT NULL,
    `quota_source` ENUM('IMAP_QUOTA', 'COMPUTED', 'MANUAL') NULL,
    `quota_checked_at` DATETIME(3) NULL,
    `last_sync_at` DATETIME(3) NULL,
    `last_sync_error` TEXT NULL,
    `consecutive_failures` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `mailboxes_address_key`(`address`),
    INDEX `mailboxes_organization_id_idx`(`organization_id`),
    INDEX `mailboxes_domain_id_idx`(`domain_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `mailbox_credentials` (
    `mailbox_id` CHAR(36) NOT NULL,
    `type` ENUM('PASSWORD', 'APP_PASSWORD', 'OAUTH2') NOT NULL DEFAULT 'PASSWORD',
    `username` VARCHAR(320) NOT NULL,
    `ciphertext` VARBINARY(2048) NOT NULL,
    `iv` BINARY(12) NOT NULL,
    `auth_tag` BINARY(16) NOT NULL,
    `wrapped_dek` VARBINARY(1024) NOT NULL,
    `key_id` VARCHAR(191) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `last_verified_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`mailbox_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `mailbox_access` (
    `user_id` CHAR(36) NOT NULL,
    `mailbox_id` CHAR(36) NOT NULL,
    `role` ENUM('OWNER', 'DELEGATE', 'READ_ONLY') NOT NULL,
    `granted_by_id` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `mailbox_access_mailbox_id_idx`(`mailbox_id`),
    PRIMARY KEY (`user_id`, `mailbox_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `mail_folders` (
    `id` CHAR(36) NOT NULL,
    `mailbox_id` CHAR(36) NOT NULL,
    `path` VARCHAR(512) NOT NULL,
    `delimiter` VARCHAR(191) NULL,
    `name` VARCHAR(255) NOT NULL,
    `special_use` ENUM('NONE', 'INBOX', 'SENT', 'DRAFTS', 'JUNK', 'TRASH', 'ARCHIVE', 'ALL', 'FLAGGED') NOT NULL DEFAULT 'NONE',
    `subscribed` BOOLEAN NOT NULL DEFAULT true,
    `selectable` BOOLEAN NOT NULL DEFAULT true,
    `uid_validity` BIGINT NULL,
    `uid_next` BIGINT NULL,
    `highest_mod_seq` BIGINT NULL,
    `total_count` INTEGER NOT NULL DEFAULT 0,
    `unread_count` INTEGER NOT NULL DEFAULT 0,
    `backfill_cursor_uid` BIGINT NULL,
    `last_synced_at` DATETIME(3) NULL,

    INDEX `mail_folders_mailbox_id_special_use_idx`(`mailbox_id`, `special_use`),
    UNIQUE INDEX `mail_folders_mailbox_id_path_key`(`mailbox_id`, `path`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `message_meta` (
    `id` CHAR(36) NOT NULL,
    `mailbox_id` CHAR(36) NOT NULL,
    `folder_id` CHAR(36) NOT NULL,
    `uid_validity` BIGINT NOT NULL,
    `uid` BIGINT NOT NULL,
    `mod_seq` BIGINT NULL,
    `message_id_header` VARCHAR(512) NULL,
    `in_reply_to` VARCHAR(512) NULL,
    `references` JSON NOT NULL,
    `thread_key` VARCHAR(64) NULL,
    `subject` TEXT NULL,
    `from_name` VARCHAR(255) NULL,
    `from_address` VARCHAR(320) NULL,
    `to_addrs` JSON NOT NULL,
    `cc_addrs` JSON NOT NULL,
    `bcc_addrs` JSON NOT NULL,
    `reply_to` JSON NOT NULL,
    `sent_at` DATETIME(3) NULL,
    `internal_date` DATETIME(3) NOT NULL,
    `size_bytes` INTEGER NOT NULL,
    `flags` JSON NOT NULL,
    `is_seen` BOOLEAN NOT NULL DEFAULT false,
    `is_flagged` BOOLEAN NOT NULL DEFAULT false,
    `is_answered` BOOLEAN NOT NULL DEFAULT false,
    `is_draft` BOOLEAN NOT NULL DEFAULT false,
    `has_attachments` BOOLEAN NOT NULL DEFAULT false,
    `preview` VARCHAR(300) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `message_meta_folder_id_internal_date_idx`(`folder_id`, `internal_date` DESC),
    INDEX `message_meta_mailbox_id_internal_date_idx`(`mailbox_id`, `internal_date` DESC),
    INDEX `message_meta_mailbox_id_message_id_header_idx`(`mailbox_id`, `message_id_header`),
    INDEX `message_meta_mailbox_id_thread_key_idx`(`mailbox_id`, `thread_key`),
    INDEX `message_meta_folder_id_is_seen_idx`(`folder_id`, `is_seen`),
    INDEX `message_meta_mailbox_id_from_address_idx`(`mailbox_id`, `from_address`),
    UNIQUE INDEX `message_meta_folder_id_uid_validity_uid_key`(`folder_id`, `uid_validity`, `uid`),
    FULLTEXT INDEX `message_meta_subject_from_name_from_address_preview_idx`(`subject`, `from_name`, `from_address`, `preview`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `compose_drafts` (
    `id` CHAR(36) NOT NULL,
    `mailbox_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `imap_draft_uid` BIGINT NULL,
    `mode` VARCHAR(191) NOT NULL DEFAULT 'new',
    `source_message_id` CHAR(36) NULL,
    `payload` JSON NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `compose_drafts_mailbox_id_user_id_idx`(`mailbox_id`, `user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `contacts` (
    `id` CHAR(36) NOT NULL,
    `mailbox_id` CHAR(36) NOT NULL,
    `email` VARCHAR(320) NOT NULL,
    `name` VARCHAR(255) NULL,
    `company` VARCHAR(191) NULL,
    `notes` TEXT NULL,
    `source` ENUM('MANUAL', 'AUTO', 'IMPORTED') NOT NULL DEFAULT 'MANUAL',
    `use_count` INTEGER NOT NULL DEFAULT 0,
    `last_used_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `contacts_mailbox_id_use_count_idx`(`mailbox_id`, `use_count` DESC),
    INDEX `contacts_mailbox_id_name_idx`(`mailbox_id`, `name`),
    UNIQUE INDEX `contacts_mailbox_id_email_key`(`mailbox_id`, `email`),
    FULLTEXT INDEX `contacts_email_name_company_idx`(`email`, `name`, `company`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `signatures` (
    `id` CHAR(36) NOT NULL,
    `mailbox_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NULL,
    `name` VARCHAR(191) NOT NULL,
    `html` MEDIUMTEXT NOT NULL,
    `is_default_new` BOOLEAN NOT NULL DEFAULT false,
    `is_default_reply` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `signatures_mailbox_id_user_id_idx`(`mailbox_id`, `user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rate_limit_buckets` (
    `key` VARCHAR(191) NOT NULL,
    `count` INTEGER NOT NULL DEFAULT 0,
    `window_start` DATETIME(3) NOT NULL,
    `blocked_until` DATETIME(3) NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `rate_limit_buckets_updated_at_idx`(`updated_at`),
    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `storage_snapshots` (
    `id` CHAR(36) NOT NULL,
    `mailbox_id` CHAR(36) NOT NULL,
    `used_bytes` BIGINT NOT NULL,
    `limit_bytes` BIGINT NULL,
    `source` ENUM('IMAP_QUOTA', 'COMPUTED', 'MANUAL') NOT NULL,
    `taken_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `storage_snapshots_mailbox_id_taken_at_idx`(`mailbox_id`, `taken_at` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` CHAR(36) NOT NULL,
    `organization_id` CHAR(36) NOT NULL,
    `actor_user_id` CHAR(36) NULL,
    `mailbox_id` CHAR(36) NULL,
    `action` VARCHAR(100) NOT NULL,
    `target_type` VARCHAR(191) NULL,
    `target_id` VARCHAR(191) NULL,
    `ip_address` VARCHAR(191) NULL,
    `user_agent` VARCHAR(512) NULL,
    `metadata` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_logs_organization_id_created_at_idx`(`organization_id`, `created_at` DESC),
    INDEX `audit_logs_mailbox_id_created_at_idx`(`mailbox_id`, `created_at` DESC),
    INDEX `audit_logs_actor_user_id_created_at_idx`(`actor_user_id`, `created_at` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `users` ADD CONSTRAINT `users_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `mail_server_profiles` ADD CONSTRAINT `mail_server_profiles_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `domains` ADD CONSTRAINT `domains_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `domains` ADD CONSTRAINT `domains_server_profile_id_fkey` FOREIGN KEY (`server_profile_id`) REFERENCES `mail_server_profiles`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `mailboxes` ADD CONSTRAINT `mailboxes_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `mailboxes` ADD CONSTRAINT `mailboxes_domain_id_fkey` FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `mailbox_credentials` ADD CONSTRAINT `mailbox_credentials_mailbox_id_fkey` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `mailbox_access` ADD CONSTRAINT `mailbox_access_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `mailbox_access` ADD CONSTRAINT `mailbox_access_mailbox_id_fkey` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `mailbox_access` ADD CONSTRAINT `mailbox_access_granted_by_id_fkey` FOREIGN KEY (`granted_by_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `mail_folders` ADD CONSTRAINT `mail_folders_mailbox_id_fkey` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `message_meta` ADD CONSTRAINT `message_meta_mailbox_id_fkey` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `message_meta` ADD CONSTRAINT `message_meta_folder_id_fkey` FOREIGN KEY (`folder_id`) REFERENCES `mail_folders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `compose_drafts` ADD CONSTRAINT `compose_drafts_mailbox_id_fkey` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `compose_drafts` ADD CONSTRAINT `compose_drafts_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contacts` ADD CONSTRAINT `contacts_mailbox_id_fkey` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `signatures` ADD CONSTRAINT `signatures_mailbox_id_fkey` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `signatures` ADD CONSTRAINT `signatures_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `storage_snapshots` ADD CONSTRAINT `storage_snapshots_mailbox_id_fkey` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_organization_id_fkey` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
