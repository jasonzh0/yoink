declare module '@builder.io/html-to-figma' {
  export function htmlToFigma(
    selector?: HTMLElement | string,
    useFrames?: boolean,
    time?: boolean
  ): unknown[];
}
