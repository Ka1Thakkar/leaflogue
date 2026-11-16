/** Tiny deterministic PDF: searchable text pages or an image-only page, no private content. */
export function readerPdf(imageOnly = false): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 8 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '', '', '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\nRGB\nendstream',
  ];
  const stream = (value: string) => `<< /Length ${Buffer.byteLength(value)} >>\nstream\n${value}\nendstream`;
  objects[5] = stream(imageOnly ? 'q 200 0 0 250 40 140 cm /Im1 Do Q' : 'BT /F1 18 Tf 40 440 Td (A quiet PDF beginning.) Tj 0 -36 Td (We read deliberately.) Tj ET');
  objects[6] = stream(imageOnly ? 'q 0.8 g 40 40 200 300 re f Q' : 'BT /F1 18 Tf 40 440 Td (A second PDF page.) Tj 0 -36 Td (Return to this paragraph.) Tj ET');
  let source = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((value, index) => { offsets.push(Buffer.byteLength(source)); source += `${index + 1} 0 obj\n${value}\nendobj\n`; });
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source);
}
