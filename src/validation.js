import { HttpError } from './errors.js';

export const MAX_EVENTS_PER_BATCH = 50;
export const MAX_EVENT_TEXT_LENGTH = 4096;
export const MAX_EVENT_ID_LENGTH = 128;

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export function requireObject(value, name = 'body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'invalid_request', `${name} must be a JSON object`);
  }
  return value;
}

export function validateUuid(value) {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    throw new HttpError(400, 'invalid_uuid', 'uuid must be a UUID v4');
  }
  return value.toLowerCase();
}

export function validateAfter(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(400, 'invalid_cursor', 'after must be a non-negative integer');
  }
  return value;
}

export function validateExtensionEvents(value) {
  if (!Array.isArray(value)) {
    throw new HttpError(400, 'invalid_events', 'events must be an array');
  }
  if (value.length > MAX_EVENTS_PER_BATCH) {
    throw new HttpError(400, 'too_many_events', `events must contain at most ${MAX_EVENTS_PER_BATCH} items`);
  }
  return value.map(validateExtensionEvent);
}

export function validateExtensionEvent(event) {
  requireObject(event, 'event');

  if (!isSafeEventId(event.id)) {
    throw new HttpError(400, 'invalid_event_id', 'event.id must be 1-128 safe characters');
  }
  if (event.replyTo !== undefined && !isSafeEventId(event.replyTo)) {
    throw new HttpError(400, 'invalid_reply_to', 'event.replyTo must be 1-128 safe characters');
  }
  if (!['user', 'assistant', 'system'].includes(event.role)) {
    throw new HttpError(400, 'invalid_event_role', 'event.role must be user, assistant, or system');
  }
  if (event.type !== 'text') {
    throw new HttpError(400, 'invalid_event_type', 'event.type must be text');
  }
  if (typeof event.text !== 'string' || event.text.length > MAX_EVENT_TEXT_LENGTH) {
    throw new HttpError(400, 'invalid_event_text', `event.text must be a string up to ${MAX_EVENT_TEXT_LENGTH} characters`);
  }

  const normalized = {
    id: event.id,
    role: event.role,
    type: 'text',
    text: event.text
  };
  if (event.replyTo !== undefined) {
    normalized.replyTo = event.replyTo;
  }
  return normalized;
}

export function isSafeEventId(value) {
  return typeof value === 'string' && value.length <= MAX_EVENT_ID_LENGTH && EVENT_ID_PATTERN.test(value);
}

export function validateStartToken(value) {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) {
    return null;
  }
  return value;
}

export function validateTelegramText(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_EVENT_TEXT_LENGTH) {
    return null;
  }
  return value;
}

export function validateChatId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^-?\d{1,20}$/.test(value)) {
    return value;
  }
  return null;
}
