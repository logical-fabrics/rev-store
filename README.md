# rev-store

# Install

```bash
$ yarn add rev-store

or

$ npm install rev-store
```

# Usage

## upload(payload, files, dataUrls, bucketName, endpoint)

ファイルのアップロードを行います。 正常に完了すると JWT が返却されます。
エラー発生時には、`null` が返却されます。

```js
const { upload } = require('rev-store')
const jwt = await upload(
  { foo: 'bar' }, // 任意のオブジェクト
  ['hoge.jpeg'], // ファイル名
  ['data:image/jpeg;base64,/hoge'], // DATAURLスキームによるファイル
  'hoge.app.com', // 指定のバケット
  'https://hogehoge.com' // 指定のエンドポイント
)
```

## verify(jwtStr, endpoint)

アップロード時に生成された JWT の署名を検証します。 署名が有効な場合、戻り値にはアップロード時に指定した `payload` のオブジェクトが返却されます。 JWT 自体や署名が無効な場合は `null` が返却されます。

```js
const { verify } = require('rev-store')
const jwt = await verify('hoge', 'https://hogehoge.com')
```

## download(jwtStr, endpoint)

```js
const { download } = require('rev-store')
const jwt = await download('hoge', 'https://hogehoge.com')
```

署名が有効であれば、アップロードされたファイルの URL を返します。

有効でない場合、または、ファイルの URL の生成等に異常が発生した場合には、例外が発生します。
