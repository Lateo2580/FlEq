// tiny-codes.xlsx を作り直す手順（P3-RW2-AC15）。試験の時には走らせない。値はすべて架空で、気象庁の資料の値を含めない。
// zlib.crc32 を使うので、この script だけ Node 22.2 以上が要る（試験と読み取りは Node 20 でも動く）。
// 使い方: node reconstruction/test/telegram-gen/make-tiny-codes.mjs
import { writeFileSync } from "node:fs";
import { crc32, deflateRawSync } from "node:zlib";

const strings = [];
// 文字列は sharedStrings の番号で持つ。rPh（ふりがな）入り・<r> で分かれた文字列・& を含む名前を 1 つずつ入れる。
const si = (inner) => { strings.push(`<si>${inner}</si>`); return strings.length - 1; };
const plain = (text) => si(`<t>${text}</t>`);
const cell = (ref, index) => `<c r="${ref}" t="s"><v>${index}</v></c>`;
const row = (n, cells) => `<row r="${n}">${cells.map(([column, index]) => cell(`${column}${n}`, index)).join("")}</row>`;
const sheet = (rows) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join("")}</sheetData></worksheet>`;

const header = [plain("コード"), plain("名称")];
const kana = plain("ふりがな");
// 22: 府県予報区。
const forecast = sheet([row(1, [["A", header[0]], ["B", header[1]]]),
  row(2, [["A", plain("9990")], ["B", plain("試験予報区")]]),
  row(3, [["A", plain("9970")], ["B", plain("別予報区")]])]);
const prefs = sheet([row(1, [["A", header[0]], ["B", header[1]]]), row(2, [["A", plain("99")], ["B", plain("試験県")]]), row(3, [["A", plain("98")], ["B", plain("架空県")]])]);
// 24: A 細分区域・B 名・C ふりがな・D 市町村等・E 名・F ふりがな・G 観測点・H 名・I ふりがな。2 行目は C を省く（空のセル）。名前に & を 1 つ。
const areas = sheet([
  row(1, [["A", header[0]], ["B", header[1]]]),
  row(2, [["A", plain("990")], ["B", plain("試験区域")], ["C", kana], ["D", plain("9900100")], ["E", plain("試験市")], ["F", kana], ["G", plain("9900110")], ["H", plain("試験観測点")], ["I", kana]]),
  row(3, [["A", plain("990")], ["B", plain("試験区域")], ["D", plain("9900100")], ["E", plain("試験市")], ["F", kana], ["G", plain("9900111")], ["H", plain("試験観測点２")], ["I", kana]]),
  row(4, [["A", plain("980")], ["B", si("<t>架空&amp;区域</t>")], ["C", kana], ["D", plain("9800100")], ["E", plain("架空市")], ["F", kana], ["G", plain("9800110")], ["H", plain("架空観測点")], ["I", kana]]),
]);
// 41: 震央地名。<r> で分かれた名前を 1 つと、ふりがな（rPh）入りの名前を 1 つ（choices が返す名前に付ける）。
const places = sheet([row(1, [["A", header[0]], ["B", header[1]]]),
  row(2, [["A", plain("997")], ["B", si("<r><t>試験</t></r><r><t>震央</t></r>")]]), row(3, [["A", plain("998")], ["B", si("<t>架空沖</t><rPh sb=\"0\" eb=\"3\"><t>かくうおき</t></rPh>")]])]);

// シートの file の番号は名前の順と変える（"24" が sheet1.xml）。
const sheets = [["24", "sheet1.xml", areas], ["22", "sheet2.xml", forecast], ["23", "sheet3.xml", prefs], ["41", "sheet4.xml", places]];
const files = [
  ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>', 0],
  ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
    sheets.map(([name, , ], i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`, 8],
  ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
    sheets.map(([, file], i) => `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/${file}"/>`).join("")}</Relationships>`, 0],
  ...sheets.map(([, file, xml]) => [`xl/worksheets/${file}`, xml, 8]),
  ["xl/sharedStrings.xml", `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.join("")}</sst>`, 8],
];

// 圧縮方式は 8（deflate）と 0（無圧縮）の両方を使う。
const parts = [];
const central = [];
let offset = 0;
for (const [name, text, method] of files) {
  const data = Buffer.from(text, "utf8");
  const packed = method === 8 ? deflateRawSync(data) : data;
  const nameBytes = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8); local.writeUInt16LE(0x21, 12);
  local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(method, 10); entry.writeUInt16LE(0x21, 14);
  entry.writeUInt32LE(crc32(data), 16); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(nameBytes.length, 28);
  entry.writeUInt32LE(offset, 42);
  central.push(entry, nameBytes);
  parts.push(local, nameBytes, packed);
  offset += local.length + nameBytes.length + packed.length;
}
const directory = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
writeFileSync(new URL("./tiny-codes.xlsx", import.meta.url), Buffer.concat([...parts, directory, end]));
