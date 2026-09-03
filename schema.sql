CREATE TABLE IF NOT EXISTS `duty_hours` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `discordId` VARCHAR(50) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `inTime` INT(11) DEFAULT NULL,
  `outTime` INT(11) DEFAULT NULL,
  `department` VARCHAR(50) COLLATE utf8mb4_general_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_discord_out` (`discordId`, `outTime`),
  KEY `idx_department` (`department`),
  KEY `idx_inTime` (`inTime`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `duty_voice_segments` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `dutyId` BIGINT UNSIGNED NOT NULL,
  `discordId` VARCHAR(50) NOT NULL,
  `channelId` VARCHAR(50) DEFAULT NULL,
  `inTime` INT(11) NOT NULL,
  `outTime` INT(11) DEFAULT NULL,
  `isLeoVoice` TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_duty` (`dutyId`),
  KEY `idx_discord_time` (`discordId`, `inTime`, `outTime`),
  CONSTRAINT `fk_voice_duty` FOREIGN KEY (`dutyId`) REFERENCES `duty_hours` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `bot_settings` (
  `settingKey` VARCHAR(100) NOT NULL,
  `settingValue` LONGTEXT NULL,
  PRIMARY KEY (`settingKey`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `department_orgs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code` VARCHAR(50) NOT NULL,
  `name` VARCHAR(150) NOT NULL,
  `createdBy` VARCHAR(50) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_org_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `org_hours_adjustments` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `orgCode` VARCHAR(50) NOT NULL,
  `discordId` VARCHAR(50) DEFAULT NULL,
  `hours` DECIMAL(10,2) NOT NULL DEFAULT 0,
  `reason` VARCHAR(255) DEFAULT NULL,
  `createdBy` VARCHAR(50) DEFAULT NULL,
  `createdAt` INT(11) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_org` (`orgCode`),
  KEY `idx_org_user` (`orgCode`, `discordId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `ridealongs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `discordId` VARCHAR(50) NOT NULL,
  `department` VARCHAR(50) NOT NULL,
  `ridealongRoleId` VARCHAR(50) DEFAULT NULL,
  `result` VARCHAR(50) NOT NULL,
  `notes` TEXT NULL,
  `createdBy` VARCHAR(50) NOT NULL,
  `createdAt` INT(11) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_ride_user` (`discordId`, `department`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `reports` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `channelId` VARCHAR(50) NOT NULL,
  `ticketType` VARCHAR(30) NOT NULL,
  `department` VARCHAR(50) NOT NULL,
  `reporterId` VARCHAR(50) DEFAULT NULL,
  `reportedUserId` VARCHAR(50) DEFAULT NULL,
  `dateOfIncident` VARCHAR(100) DEFAULT NULL,
  `gameId` VARCHAR(100) DEFAULT NULL,
  `clip` TEXT NULL,
  `description` TEXT NULL,
  `context` TEXT NULL,
  `anonymous` TINYINT(1) NOT NULL DEFAULT 0,
  `createdAt` INT(11) NOT NULL,
  `closedAt` INT(11) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_report_channel` (`channelId`),
  KEY `idx_report_dept` (`department`),
  KEY `idx_reporter` (`reporterId`),
  KEY `idx_reported` (`reportedUserId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
