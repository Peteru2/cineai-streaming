const RULES: [RegExp, string][] = [
  [
    /no video track|no valid dimensions|could not be read as a video|video length/i,
    "We couldn't find a video in this file. Please export it again as MP4 and upload it.",
  ],
  [/corrupt/i, 'The video file seems to be damaged. Please export it again and upload the new file.'],
  [/longer than/i, 'This video is longer than we currently allow. Please upload a shorter cut.'],
  [/taller than/i, 'This video has a higher resolution than we can handle. Please export it at 4K or lower.'],
  [
    /missing from storage|not finished within|abandoned/i,
    "This upload didn't finish. Please select the file again and upload it.",
  ],
  [
    /stalled|exceeded the time limit|gave up/i,
    'Our servers had trouble processing this video, even after several tries. Please try again in a few minutes.',
  ],
];

export const GENERIC_FAILURE = 'Something went wrong while preparing your video. Please try uploading it again.';

export function friendlyFailure(reason: string | null | undefined): string {
  if (!reason) return GENERIC_FAILURE;
  for (const [pattern, message] of RULES) {
    if (pattern.test(reason)) return message;
  }
  return GENERIC_FAILURE;
}