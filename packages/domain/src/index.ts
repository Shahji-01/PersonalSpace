export { createCaptureService } from './capture';
export { createExportAccess } from './export-access';
export { createAttachmentService } from './attachments';
export { createAttachmentProcessor, type ProcessingResult } from './attachment-processing';
export { DomainError } from './errors';
export { createNoteHistoryService } from './note-history';
export { createSearchService } from './search';
export {
  createReminder,
  updateReminder,
  snoozeReminder,
  setReminderStatus,
  reminderFor,
  trashedReminderFor,
} from './reminders';
export {
  createCollection,
  renameCollection,
  moveCollection,
  collectionFor,
  requireCollection,
  saveResource,
  updateResource,
  setResourceStatus,
  setResourceProgress,
  setResourceCollection,
  resourceFor,
  trashedResourceFor,
} from './learning';
export {
  personFor,
  createPerson,
  updatePerson,
  accountFor,
  requireAccount,
  createAccount,
  updateAccount,
  categoryFor,
  createCategory,
  updateCategory,
  transactionFor,
  createTransaction,
  editTransaction,
  voidTransaction,
  restoreTransaction,
  debtFor,
  createDebt,
  setDebtStatus,
} from './money';
export { getPreferences, updatePreferences } from './preferences';
export {
  cleanupTrash,
  cleanupIdempotencyKeys,
  reconcileBalances,
  expireExports,
} from './maintenance';
export {
  generateExportData,
  exportToJson,
  exportToCsv,
  exportToMarkdown,
  type ExportData,
  type ExportScope,
  type ExportFormat,
} from './export';
export {
  requestDeletion,
  cancelDeletion,
  getDeletionStatus,
  executePendingDeletions,
} from './deletion';
export { extractMetadata, processPendingMetadata } from './metadata';
export { deliverDueReminders } from './notifications';
export {
  parseYouTubeId,
  fetchYouTubeMetadata,
  fetchPlaylistItems,
  expandPlaylist,
} from './youtube';
export {
  ConsoleEmailProvider,
  ResendEmailProvider,
  createEmailProvider,
  processPendingEmails,
  type EmailProvider,
} from './email';
