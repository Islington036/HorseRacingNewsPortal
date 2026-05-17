# Codex 作業ガイド

## プロジェクト概要
- 個人利用向けの競馬ニュース早見ポータルです。
- `JapaneseHorseRacingNewsPortal.html` は日本競馬ニュース用です。
- `InternationalHorseRacingNewsPortal.html` は海外競馬ニュース用です。
- どちらも単一HTMLで動かし、外部サイト取得はブラウザの `fetch` と設定済みCORSプロキシ/Jina Readerを経由します。

## 編集方針
- HTML、CSS、JavaScriptは原則として対象HTML内にまとめます。
- カスタマイズしやすいように、取得日数、プロキシ、対象サイトなどの変数はJS先頭の `CONFIG` に置きます。
- ヘッドラインとサムネイルだけを扱い、本文転載はしません。
- サイト側のHTML変更に備え、サイト固有抽出は `extractSiteSpecificItems` から分岐させます。
- 関数には日本語コメントを付け、複雑な分岐や抽出条件にも処理意図のコメントを入れます。

## 確認手順
- 構文確認:
  `node -e "const fs=require('fs'); const html=fs.readFileSync('InternationalHorseRacingNewsPortal.html','utf8'); const scripts=[...html.matchAll(/<script>([\\s\\S]*?)<\\/script>/g)]; scripts.forEach((m,i)=>{ new Function(m[1]); console.log('script '+(i+1)+' ok'); });"`
- ローカル表示:
  `python3 -m http.server 8765`
- ブラウザ確認:
  `http://127.0.0.1:8765/InternationalHorseRacingNewsPortal.html`
- 更新ボタンを押し、取得件数、失敗サイト、サムネイル、地域/サイト/検索フィルタを確認します。

## 注意点
- 公開CORSプロキシは制限やレートリミットで不安定になることがあります。
- 取得0件のサイトは、HTTPエラーがなくても抽出失敗や3日以内記事なしの可能性があります。
- 画像が取れない記事はダミーサムネイル表示を維持します。
- git作業では、ユーザーが触った変更を勝手に戻しません。
