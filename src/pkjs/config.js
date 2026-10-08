'use strict';

// Settings stay on the phone. These names are deliberately absent from watch messageKeys.
module.exports = [
  { type: 'text', defaultValue: '途中に記録がない時間帯は、その後に正の使用量の記録があれば0kWhとして計算します（未使用推定）。その後の記録が途絶えている場合は欠損として扱います。今日の記録は判定に使いますが、料金集計は前日までです。詳細のZero inferredに未使用推定した30分枠数を表示します。' },
  { type: 'heading', defaultValue: '電気代の概算設定 v1.0.8' },
  { type: 'text', defaultValue: 'JST暦月の完了日までの概算です。月末予測は完了日の平均使用量から計算します。確定請求額とは異なります。' },
  { type: 'text', defaultValue: '前日までのデータが揃っている場合、起動や時計のSELECTでは保存結果（CACHE）を使い、APIから取り直しません。日付が変わった場合や不足がある場合は再取得します。API側の訂正などを取り直す場合は、入力値を変えずに下の「保存して更新」を押してください。' },
  { type: 'section', items: [
    { type: 'heading', defaultValue: '適用月と基本料金' },
    { type: 'input', messageKey: 'month', label: '適用月（YYYY-MM）', defaultValue: '', attributes: { type: 'text', placeholder: 'YYYY-MM' } },
    { type: 'input', messageKey: 'contractStartDate', label: '供給開始日（任意・YYYY-MM-DD）', defaultValue: '', attributes: { type: 'text', placeholder: 'YYYY-MM-DD' } },
    { type: 'text', defaultValue: '月の途中で供給が始まった場合は開始日を入力してください（例：2026-10-03）。契約前は集計・欠測・料金の対象外です。空欄は月初から集計します。開始後の欠測を飛ばすための設定ではありません。翌月以降は月初から集計します。月末予測は開始日から月末までの使用量と基本料金の日割りで計算します。' },
    { type: 'text', defaultValue: '契約容量は6kVA固定です。基本単価は契約全体ではなく1kVAあたりを入力してください。すべての単価を契約に合わせて入力してください。未入力は0として扱いません。' },
    { type: 'select', messageKey: 'basicMode', label: '基本単価の単位', defaultValue: 'month', options: [{ label: '円/kVA/月', value: 'month' }, { label: '円/kVA/日', value: 'day' }] },
    { type: 'input', messageKey: 'basicRate', label: '基本単価（非負）', defaultValue: '', attributes: { type: 'number', min: 0, step: 'any' } },
  ] },
  { type: 'section', items: [
    { type: 'heading', defaultValue: '時間帯別2単価' },
    { type: 'text', defaultValue: '従量料金はJSTの時間帯別2単価です。第1単価は開始時刻以上・終了時刻未満、第2単価は残りの時間です。開始・終了は異なる30分境界を入力し、日付をまたぐ時間帯も指定できます。' },
    { type: 'input', messageKey: 'rate1', label: '第1時間帯の単価（円/kWh）', defaultValue: '', attributes: { type: 'number', min: 0, step: 'any' } },
    { type: 'input', messageKey: 'bandStart', label: '第1時間帯の開始（JST HH:mm）', defaultValue: '', attributes: { type: 'text', placeholder: 'HH:mm' } },
    { type: 'input', messageKey: 'bandEnd', label: '第1時間帯の終了（JST HH:mm）', defaultValue: '', attributes: { type: 'text', placeholder: 'HH:mm' } },
    { type: 'input', messageKey: 'rate2', label: '残りの時間帯の単価（円/kWh）', defaultValue: '', attributes: { type: 'number', min: 0, step: 'any' } },
  ] },
  { type: 'section', items: [
    { type: 'heading', defaultValue: '調整額と税' },
    { type: 'input', messageKey: 'fuelRate', label: '燃料調整（円/kWh、負数可）', defaultValue: '', attributes: { type: 'number', step: 'any' } },
    { type: 'input', messageKey: 'governmentRate', label: '政府調整の減額（円/kWh、非負）', defaultValue: '', attributes: { type: 'number', min: 0, step: 'any' } },
    { type: 'text', defaultValue: '再エネ単価は4.18円/kWh固定です。基本・従量・燃料・政府調整・再エネ4.18のすべてに、下の同じ税区分を適用します。混在税区分には対応しません。' },
    { type: 'select', messageKey: 'taxMode', label: '全項目の税区分', defaultValue: 'included', options: [{ label: '税込', value: 'included' }, { label: '税抜', value: 'excluded' }] },
    { type: 'input', messageKey: 'taxRate', label: '消費税率（%）', defaultValue: 10, attributes: { type: 'number', min: 0, step: 'any' } },
    { type: 'text', defaultValue: '税込では税率を変更しても合計は変わりません。税率は税抜だけに適用します。最後の合計を円単位で一度切り上げます。実契約の端数・日割り方式を再現する保証はありません。' }
  ] },
  { type: 'section', items: [
    { type: 'heading', defaultValue: 'オクトパス認証' },
    { type: 'text', defaultValue: 'メールとパスワードはスマートフォンのlocalStorageに保存します。暗号化された秘密保管庫ではありません。時計へは送信しません。空欄なら保存済みの値を保持します。' },
    { type: 'input', messageKey: 'email', label: 'メールアドレス（変更時のみ）', defaultValue: '', attributes: { type: 'email' } },
    { type: 'input', messageKey: 'password', label: 'パスワード（変更時のみ）', defaultValue: '', attributes: { type: 'password' } },
    { type: 'heading', defaultValue: '認証情報の消去' },
    { type: 'text', defaultValue: '下の消去を選び「保存して更新」を押すと、保存済み認証情報を消去します。' },
    { type: 'toggle', messageKey: 'clearCredentials', label: '保存済み認証情報を消去', defaultValue: false }
  ] },
  { type: 'section', items: [
  { type: 'heading', defaultValue: '試験データ' },
  { type: 'toggle', messageKey: 'demo', label: '固定の試験データを表示', defaultValue: false },
  { type: 'text', defaultValue: '試験データは実アカウントの料金ではありません。時計のSELECTで手動更新、予測画面からDOWNで現在額、もう一度DOWNで詳細、詳細の上下でスクロール、BACKで主画面へ戻れます。' },
  ] },
  { type: 'submit', defaultValue: '保存して更新' }
];
