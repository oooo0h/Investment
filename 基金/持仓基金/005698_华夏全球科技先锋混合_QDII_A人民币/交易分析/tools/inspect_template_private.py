from pathlib import Path
import zipfile, xml.etree.ElementTree as ET, re, json

root = Path(__file__).resolve().parents[1]
source = root / 'outputs/fund_fifo_20260902/005698_逐笔收益_FIFO_截至2026-09-02.xlsx'
ns = {'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(source) as z:
    strings=[]
    if 'xl/sharedStrings.xml' in z.namelist():
        strings=[''.join(x.itertext()) for x in ET.fromstring(z.read('xl/sharedStrings.xml'))]
    wb=ET.fromstring(z.read('xl/workbook.xml'))
    rels={x.attrib['Id']:x.attrib['Target'] for x in ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
    for sheet in wb.find('s:sheets',ns):
        target=rels[sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]
        target=target.lstrip('/') if target.startswith('/') else 'xl/'+target
        xml=ET.fromstring(z.read(target))
        out={'name':sheet.attrib['name'], 'headers':[], 'formula_samples':[], 'dimensions':xml.find('s:dimension',ns).attrib if xml.find('s:dimension',ns) is not None else {},'merges':[x.attrib for x in xml.findall('s:mergeCells/s:mergeCell',ns)]}
        for c in xml.findall('.//s:sheetData/s:row/s:c',ns):
            addr=c.attrib['r']; row=int(re.sub('[A-Z]','',addr))
            v=c.find('s:v',ns); f=c.find('s:f',ns)
            if f is not None and len(out['formula_samples'])<6:
                safe=re.sub(r'(?<![A-Z$])\b\d+(?:\.\d+)?\b','[n]',f.text or '')
                out['formula_samples'].append([addr,safe])
            if row>8: continue
            val=None
            if c.attrib.get('t')=='s' and v is not None: val=strings[int(v.text)]
            elif c.attrib.get('t')=='str' and v is not None: val=v.text
            elif c.attrib.get('t')=='inlineStr': val=''.join(c.find('s:is',ns).itertext())
            if val: out['headers'].append([addr,re.sub(r'\d+(?:[.,]\d+)*','[n]',val)])
        print(json.dumps(out,ensure_ascii=False))
