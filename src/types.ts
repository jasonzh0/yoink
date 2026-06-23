export interface StoredState {
  useFrames?: boolean;
  includeImages?: boolean;
}

export interface CaptureOptions {
  useFrames: boolean;
  includeImages: boolean;
}

export type PopupMessage =
  | { type: 'YOINK_START_PICK' }
  | { type: 'YOINK_CAPTURE_PAGE' };

export const PAYLOAD_TAG = 'yoink/figma@1';
