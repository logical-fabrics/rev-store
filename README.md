# rev-store

# Install

```bash
$ yarn add rev-store

or

$ npm install rev-store
```

# Usage

## upload(metadata, files, dataUrls, bucketName, endpoint)

```js
const { upload } = require('rev-store')
const jwt = await upload(
  { contentType: 'image/jpeg' },
  ['hoge.jpeg'],
  ['data:image/jpeg;base64,/hoge'],
  'hoge.app.com',
  'https://hogehoge.com'
)
```

署名が有効であり、ファイルのアップロードが正しく行われれば、JsonWebToken を返します。

有効でない、または、ファイルのアップロード等に異常が発生した場合には、ブラウザコンソールにエラーを吐き、null を返します。

## verify(jwtStr, endpoint)

```js
const { verify } = require('rev-store')
const jwt = await verify('hoge', 'https://hogehoge.com')
```

署名が有効であれば、デコードされたペイロードを返します。

有効でない場合、ブラウザコンソールにエラーを吐き、null を返します。

## download(jwtStr, endpoint)

```js
const { download } = require('rev-store')
const jwt = await download('hoge', 'https://hogehoge.com')
```

署名が有効であれば、ファイルの URL を返します。

有効でない場合、または、ファイルの URL の生成等に異常が発生した場合には、エラーを投げます。
