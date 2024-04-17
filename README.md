# rev-store

# Install

```bash
$ yarn add rev-store

or

$ npm install rev-store
```

# Usage

## upload(payload, files, dataUrls, endpoint)

ファイルのアップロードを行います。 正常に完了すると JWT が返却されます。

エラー発生時には、例外が発生します。

```js
const { upload } = require('rev-store')
const jwt = await upload(
  { foo: 'bar' }, // 任意のオブジェクト
  ['hoge.jpeg'], // ファイル名
  ['data:image/jpeg;base64,/hoge'], // DATAURLスキームによるファイル
  'https://hogehoge.com' // 指定のエンドポイント
)
```

## verify(jwtStr, endpoint)

アップロード時に生成された JWT の署名を検証します。 署名が有効な場合、戻り値にはアップロード時に指定した `payload` のオブジェクトが返却されます。

JWT 自体や署名が無効な場合や、エラー発生時には、例外が発生します。

```js
const { verify } = require('rev-store')
const jwt = await verify('hoge', 'https://hogehoge.com')
```

## download(jwtStr, endpoint)

```js
const { download } = require('rev-store')
const jwt = await download('hoge', 'https://hogehoge.com')
```

署名が有効な場合、アップロードされたファイルの URL 返却されます。

署名が有効でない場合や、エラー発生時には、例外が発生します。

## sendOrderEmail(serviceId, shopId, orderIds, endpoint)

店舗に注文メールを送信します。

エラー発生時には、例外が発生します。

```js
const { sendOrderEmail } = require('rev-store')
await sendOrderEmail(
  'hoge', // 指定のサービスID
  '0000', // 店舗ID
  ['0000-0000', '1111-1111'], // 注文ID
  'https://hogehoge.com' // 指定のエンドポイント
)
```
