"""Writes the knowledge-file fixtures for pipeline tests. Run: python3 make-fixtures.py

Kept as a script so the binary fixtures can be reviewed and regenerated.
"""
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))


def pdf(path, pages):
    """A minimal PDF: one Helvetica text line list per page; an empty list makes an image-only-like page."""
    objects = ["<< /Type /Catalog /Pages 2 0 R >>", None]
    kids = []
    font_id = 3
    objects.append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    for lines in pages:
        ops = ["BT /F1 12 Tf 72 720 Td 14 TL"]
        for line in lines:
            ops.append("(" + line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") + ") Tj T*")
        ops.append("ET")
        # A filled rectangle stands in for a scanned image on text-less pages.
        stream = ("\n".join(ops) if lines else "0.5 g 72 72 468 648 re f")
        objects.append("<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream))
        content_id = len(objects)
        objects.append(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents %d 0 R"
            " /Resources << /Font << /F1 %d 0 R >> >> >>" % (content_id, font_id)
        )
        kids.append(len(objects))
    objects[1] = "<< /Type /Pages /Kids [%s] /Count %d >>" % (" ".join("%d 0 R" % k for k in kids), len(kids))

    out = b"%PDF-1.4\n"
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += ("%d 0 obj\n%s\nendobj\n" % (i, body)).encode("latin-1")
    xref = len(out)
    out += ("xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)).encode()
    for off in offsets:
        out += ("%010d 00000 n \n" % off).encode()
    out += ("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)).encode()
    with open(path, "wb") as f:
        f.write(out)


def docx(path, paragraphs):
    """A minimal Word document with one run per paragraph."""
    ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    body = "".join(
        "<w:p><w:r><w:t xml:space=\"preserve\">%s</w:t></w:r></w:p>" % p.replace("&", "&amp;").replace("<", "&lt;")
        for p in paragraphs
    )
    files = {
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        "word/document.xml": '<?xml version="1.0" encoding="UTF-8"?><w:document %s><w:body>%s</w:body></w:document>' % (ns, body),
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, content in files.items():
            info = zipfile.ZipInfo(name, date_time=(2026, 11, 20, 0, 0, 0))  # fixed time: same bytes every run
            z.writestr(info, content.encode("utf-8"), zipfile.ZIP_DEFLATED)


pdf(os.path.join(HERE, "warranty.pdf"), [
    ["Warranty policy", "All phones carry a 12-month manufacturer warranty from the invoice date.",
     "Keep the invoice: the service centre asks for it."],
    ["Screen guards and cases", "Screen guards and cases are not covered by the warranty.",
     "We replace a cracked guard once, free, within 7 days of purchase."],
])
pdf(os.path.join(HERE, "scanned.pdf"), [[], []])
docx(os.path.join(HERE, "returns.docx"), [
    "Returns and exchanges",
    "Unopened phones can be returned within 14 days with the invoice.",
    "ഓർഡർ ചെയ്ത കേക്ക് 24 മണിക്കൂർ മുമ്പ് വരെ റദ്ദാക്കാം.",
])
print("fixtures written")
