"""Draw the traced divisions over each registered scan, for a by-eye check:
writes ovd_centre.png, ovd_east.png and ovd_south.png."""
import json, numpy as np
from PIL import Image, ImageDraw
from shapely.geometry import shape
from shapely import transform
from pyproj import Transformer
T=Transformer.from_crs(4326,26910,always_xy=True)
G=json.load(open('georef.json'))
d=json.load(open('richmond_divisions.geojson'))
utm=lambda g: transform(g, lambda a: np.column_stack(T.transform(a[:,0],a[:,1])))
fs=[(f['properties']['id'],utm(shape(f['geometry']))) for f in d['features']]
for name,g in G.items():
    a,b,c,dd,e,f=g['params']
    im=Image.open(g['image']).convert('RGB'); dr=ImageDraw.Draw(im)
    pix=lambda xy:[((x-e)/a,(y-f)/dd) for x,y in xy]
    for code,geo in fs:
        for part in getattr(geo,'geoms',[geo]):
            dr.line(pix(part.exterior.coords),fill=(230,0,0),width=5)
        rp=max(getattr(geo,'geoms',[geo]),key=lambda q:q.area).representative_point()
        x,y=pix([(rp.x,rp.y)])[0]; dr.text((x,y+30),code,fill=(230,0,0))
    im.crop((150,500,2450,2700)).resize((1150,1100)).save(f'ovd_{name}.png')
