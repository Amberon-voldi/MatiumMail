-- CreateTable
CREATE TABLE `compose_uploads` (
    `id` CHAR(36) NOT NULL,
    `mailbox_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `filename` VARCHAR(255) NOT NULL,
    `content_type` VARCHAR(255) NOT NULL,
    `size` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `compose_uploads_mailbox_id_user_id_idx`(`mailbox_id`, `user_id`),
    INDEX `compose_uploads_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `compose_upload_chunks` (
    `upload_id` CHAR(36) NOT NULL,
    `seq` INTEGER NOT NULL,
    `data` MEDIUMBLOB NOT NULL,

    PRIMARY KEY (`upload_id`, `seq`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `compose_upload_chunks` ADD CONSTRAINT `compose_upload_chunks_upload_id_fkey` FOREIGN KEY (`upload_id`) REFERENCES `compose_uploads`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

