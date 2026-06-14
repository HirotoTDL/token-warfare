# キャラのリカラー実験: 各マテリアルのベースカラー画像に Hue/Saturation/Value ノードを挟み、
# 色相を回して色違いバリエーションを作る。GLBエクスポート＋検証レンダ。
import bpy, math, mathutils, sys
a=sys.argv[sys.argv.index("--")+1:]
src,out,render,hue,sat = a[0],a[1],a[2],float(a[3]),float(a[4])
bpy.ops.wm.read_factory_settings(use_empty=True)
before=set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=src)
meshes=[o for o in bpy.data.objects if o.type=='MESH']
for o in [o for o in bpy.data.objects if o not in before and o.type=='ARMATURE']: pass
# 全マテリアルにHueノード挿入
done=set()
for o in meshes:
    for slot in o.material_slots:
        m=slot.material
        if not m or m.name in done: continue
        done.add(m.name); m.use_nodes=True; nt=m.node_tree
        bsdf=next((n for n in nt.nodes if n.type=='BSDF_PRINCIPLED'),None)
        if not bsdf: continue
        bc=bsdf.inputs["Base Color"]
        if not bc.is_linked:
            # 画像が無い単色 → 色相回転を近似(HSV変換)
            import colorsys
            r,g,b,_=bc.default_value; h,s,v=colorsys.rgb_to_hsv(r,g,b)
            h=(h+hue)%1.0; s=min(1,s*sat)
            bc.default_value=(*colorsys.hsv_to_rgb(h,s,v),1); continue
        src_sock=bc.links[0].from_socket
        hsv=nt.nodes.new("ShaderNodeHueSaturation")
        hsv.inputs["Hue"].default_value=(0.5+hue)%1.0  # 0.5=無変化、±で色相回転
        hsv.inputs["Saturation"].default_value=sat
        hsv.location=(bsdf.location.x-300,bsdf.location.y)
        nt.links.new(src_sock,hsv.inputs["Color"])
        nt.links.new(hsv.outputs["Color"],bc)
print("recolored materials:",len(done))
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=out,export_format='GLB',use_selection=True,export_yup=True,export_skins=True)
print("EXPORT",out)
# レンダ(正面・全身)
mn=mathutils.Vector((1e9,)*3); mx=mathutils.Vector((-1e9,)*3)
for o in meshes:
    for c in o.bound_box:
        w=o.matrix_world@mathutils.Vector(c)
        for i in range(3): mn[i]=min(mn[i],w[i]); mx[i]=max(mx[i],w[i])
ctr=(mn+mx)/2; h=mx.z-mn.z
cam_d=bpy.data.cameras.new("C"); cam=bpy.data.objects.new("C",cam_d); bpy.context.scene.collection.objects.link(cam)
cam.location=(ctr.x,ctr.y-h*2.2,ctr.z+h*0.1)
look=mathutils.Vector((ctr.x,ctr.y,ctr.z))-mathutils.Vector(cam.location)
cam.rotation_euler=look.to_track_quat('-Z','Y').to_euler(); bpy.context.scene.camera=cam
ld=bpy.data.lights.new("L",'SUN'); lo=bpy.data.objects.new("L",ld); bpy.context.scene.collection.objects.link(lo); ld.energy=3.0; lo.rotation_euler=(math.radians(52),math.radians(10),math.radians(25))
w=bpy.data.worlds.new("W"); w.use_nodes=True; w.node_tree.nodes["Background"].inputs[0].default_value=(0.75,0.80,0.90,1); bpy.context.scene.world=w
sc=bpy.context.scene; sc.render.engine='BLENDER_EEVEE_NEXT'; sc.render.resolution_x=360; sc.render.resolution_y=480; sc.render.filepath=render; sc.view_settings.view_transform='AgX'
bpy.ops.render.render(write_still=True); print("RENDER",render)
