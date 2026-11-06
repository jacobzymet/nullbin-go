export interface QrMatrix {
  readonly size: number;
  getModule(x: number, y: number): boolean;
}

export declare const qrcodegen: {
  QrCode: {
    encodeText(text: string, level: unknown): QrMatrix;
    Ecc: { MEDIUM: unknown };
  };
};
