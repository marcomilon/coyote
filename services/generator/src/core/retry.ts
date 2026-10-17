/** Thrown for a step that may pass later, so its queue delivers the message again (and alerts when it gives up). */
export class RetryLater extends Error {}
