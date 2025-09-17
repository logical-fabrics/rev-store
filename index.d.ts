export function upload(
  metadata: object,
  files: string[],
  dataUrls: string[],
  endpoint: string
): string

export function verify(jwtStr: string, endpoint: string): object

export function download(jwtStr: string, endpoint: string): string[]

export function sendOrderEmail(
  serviceId: string,
  shopId: string,
  orderIds: string[],
  endpoint: string
): object

export function registerOrder(
  serviceId: string,
  metadata: object,
  endpoint: string
): Promise<object>
