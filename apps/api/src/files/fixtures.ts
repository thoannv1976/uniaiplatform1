import { strToU8, zipSync } from 'fflate';

/** Small but real sample files of each kind, built in memory (no binary fixtures in git). */

export function samplePdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((text, i) => {
    const content = `BT /F1 18 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
    objects[4 + i * 2] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objects[5 + i * 2] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const zip = (files: Record<string, string>) =>
  Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));

export function sampleDocx(): Buffer {
  return zip({
    '[Content_Types].xml': '<Types/>',
    'docProps/app.xml': '<Properties><Pages>2</Pages></Properties>',
    'word/document.xml':
      '<w:document><w:body>' +
      '<w:p><w:r><w:t>Quy chế đào tạo</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t xml:space="preserve">Điều 1. </w:t></w:r><w:r><w:t>Phạm vi &amp; đối tượng</w:t></w:r></w:p>' +
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Học phần</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Tín chỉ</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
      '</w:body></w:document>',
  });
}

export function samplePptx(): Buffer {
  const slide = (lines: string[]) =>
    `<p:sld><p:cSld><p:spTree>${lines.map((l) => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`).join('')}</p:spTree></p:cSld></p:sld>`;
  return zip({
    'ppt/presentation.xml': '<p:presentation/>',
    'ppt/slides/slide1.xml': slide(['Giới thiệu', 'Mục tiêu môn học']),
    'ppt/slides/slide2.xml': slide(['Nội dung']),
    'ppt/slides/slide10.xml': slide(['Kết luận']),
  });
}

export function sampleXlsx(): Buffer {
  return zip({
    'xl/workbook.xml':
      '<workbook><sheets><sheet name="Điểm" sheetId="1" r:id="rId1"/><sheet name="Trống" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml':
      '<sst><si><t>Họ tên</t></si><si><t>Điểm</t></si><si><r><t>Nguyễn </t></r><r><t>Văn A</t></r></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>8.5</v></c><c r="D2" t="inlineStr"><is><t>Đạt</t></is></c></row>' +
      '</sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData/></worksheet>',
  });
}

/** 1×1 transparent PNG. */
export const SAMPLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
