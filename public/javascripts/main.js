import { genUnitSphereMesh, TriMesh, SkyBoxVertices } from './geo3d.js';
import { Vec3, Mat4, Quat } from './mb-matrix.js';
import { getProgram, getGLContext } from './glutils.js';
import { Fixed, EARTH_RADIUS } from './constants.js';

const PX = 'px', PY = 'py', PZ = 'pz', NX = 'nx', NY = 'ny', NZ = 'nz'
const SKY_IMAGES = [PX, PY, PZ, NX, NY, NZ];
const PLANETS = ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];

class Resources {

    constructor() {
        this.shaders = {};
        this.images = {};
    }

    async load_shader(url, name) {
        this.shaders[name] = null;
        let resp = await fetch('shaders/' + url);
        let txt = await resp.text();
        this.shaders[name] = txt;
    }

    async load_image(url, name) {
        this.images[name] = null;
        var image = new Image();

        image.src = 'images/' + url;
        await image.decode();
        this.images[name] = image;
    }

    is_done() {
        let has_non_null_elements_only = true;
        [this.shaders, this.images].map((v, i, a) => {
            //console.log(v, i, a);
            has_non_null_elements_only &= (Object.keys(v).length > 0 && !Object.values(v).includes(null));
        });
        return has_non_null_elements_only;
    }

    async wait_until_loaded(timeout_sec = 10) {
        return new Promise(async (resolve, reject) => {
            var elapsed_ms = 0.0, interval_ms = 50;
            while (elapsed_ms / 1000 < timeout_sec) {
                await new Promise(res => { setTimeout(() => { res(); }, interval_ms) });
                elapsed_ms += interval_ms;
                if (this.is_done()) {
                    return resolve();
                }
            }
            reject('Taking too long!');
        });
    }
}

class Timer {
    constructor() {
        this.started_at = 0;
        this.time = 0;
    }
    start() {
        this.started_at = new Date().getTime();
        return this.started_at;
    }

    stop() {
        this.time = new Date().getTime() - this.started_at;
        return this.time
    }
}

var resources = new Resources();
resources.load_shader('mainvs.txt', 's_vs');
resources.load_shader('mainfs.txt', 's_fs');
resources.load_shader('meshfs.txt', 'mesh_fs');
resources.load_shader('skyvs.txt', 'sky_vs');
resources.load_shader('skyfs.txt', 'sky_fs');
resources.load_image('earth_daytime.jpg', 'earth');
resources.load_image('moon.jpg', 'moon');
resources.load_image('sun.jpg', 'sun');

SKY_IMAGES.forEach((v, i, a) => {
    resources.load_image(`skybox_hr/${v}.png`, v);
});

PLANETS.forEach((v,i,a) => {
    resources.load_image(`2k_${v}.jpg`, v);
})

class Camera {
    constructor(pos = [0, 0, 500]) {
        this.velocity = [0, 0, 0];
        this.pos = pos;
        this.up = [0, 1, 0];
        this.dir = [0, 0, 1];
        this.right = [1, 0, 0]
        this.zoom = 1;
        this.theta_x = 0.0;
        this.theta_y = 0.0;
        this.omega_x = 0.0;
        this.omega_y = 0.0;
        this.rot_mat = new Float32Array([...this.right, 0, ...this.up, 0, ...this.dir, 0, 0, 0, 0, 1])
        this.aspect = 1;
        this._fovY = .90;
        this._maxZ = Infinity;
        this.p_mat = Mat4.perspective(Mat4.identity(), this._fovY, this._aspect, 1.0, this._maxZ);
        this._slerp = { start: null, end: null, t: 0.0 };
        this.rotate_speed = 1.0;
        this.move_speed = 1.0
        this.percent_c = 1.0;
        this._speed_settings_displayed = true;
        this._damper_r = 1.0;
        $("#cam_speed_btn").click(this.toggle_speed_settings);
        this.toggle_speed_settings();

        let cam = this;
        let neg = Vec3.negate;

        this._drag = {begin: [0,0], dragging: false, able: true};

        $('#control').mouseenter((ev) => {cam._drag.able = false});
        $('#control').mouseleave((ev) => {cam._drag.able = true});

        $('#main_can_wrap').mousedown((ev) => {cam._drag.dragging = true; cam._drag.begin = [ev.screenX, ev.screenY];});
        $('#main_can_wrap').mouseup((ev) => {
            cam._drag.dragging = false;
            if (!cam._drag.able) {
                return;
            }
            let d = ev.screenX - this._drag.begin[0];
            let dY = ev.screenY - this._drag.begin[1];
            let is_Y = Math.abs(d) > Math.abs(dY);
            if (d*d + dY*dY < 100) {
                return;
            }
            this.omega_y = d/100;
            this.omega_x = dY/100;
            this._damper_r = .7;
            Tracking.disable_auto_targeting();
        });
        $('#main_can_wrap').mouseleave((ev) => {cam._drag.dragging = false;});

        let settings = {
            cam_forward: () => neg(cam.dir),
            cam_back: () => cam.dir,
            cam_strafe_left: () => neg(cam.right),
            cam_strafe_right: () => cam.right,
            cam_rise: () => cam.up,
            cam_fall: () => neg(cam.up),
        }
        
        Object.keys(settings).forEach((k) => {
            document.getElementById(k).onmousedown = (ev) => { Vec3.scale(cam.velocity, settings[k](), cam.move_speed); };
            let f = (ev) => { cam.velocity = [0, 0, 0]; Tracking.disable_lock() };
            document.getElementById(k).onmouseup = f;
            //document.getElementById(k).onmouseleave = f;
        });

        let angles = {
            cam_tilt_up: (ev) => { cam.omega_x = cam.rotate_speed },
            cam_tilt_down: (ev) => { cam.omega_x = -cam.rotate_speed },
            cam_tilt_left: (ev) => { cam.omega_y = cam.rotate_speed },
            cam_tilt_right: (ev) => { cam.omega_y = -cam.rotate_speed },
        }
        Object.keys(angles).forEach((k) => {
            document.getElementById(k).onmousedown = (ev) => {angles[k](ev); this._damper_r = 1.0 };
            let f = (ev) => { cam.omega_x = 0.0; cam.omega_y = 0.0; Tracking.disable_auto_targeting() };
            document.getElementById(k).onmouseup = f;
            //document.getElementById(k).onmouseleave = f;
        });

        document.getElementById("cam_recenter").onclick = (ev) => {
            cam.up = [0, 1, 0];
            Vec3.cross(cam.dir, cam.right, cam.up);
            Vec3.cross(cam.right, cam.up, cam.dir);
            let rot_mat = this.rot_mat;
            rot_mat[4] = this.up[0];
            rot_mat[5] = this.up[1];
            rot_mat[6] = this.up[2];

            rot_mat[0] = this.right[0];
            rot_mat[1] = this.right[1];
            rot_mat[2] = this.right[2];

            rot_mat[8] = this.dir[0];
            rot_mat[9] = this.dir[1];
            rot_mat[10] = this.dir[2];
        };
    }

    set_aspect(aspect) {
        if (this.aspect !== aspect) {
            this.p_mat = Mat4.perspective(Mat4.identity(), this._fovY, aspect, 1.0, this._maxZ);
            this.aspect = aspect;
        }
    }

    toggle_speed_settings() {
        this._speed_settings_displayed = !this._speed_settings_displayed;
        $("#cam_speed_settings").css("display", this._speed_settings_displayed ? "inline-block" : "none");
    }

    set_dirs() {
        let rot_mat = this.rot_mat;
        this.up[0] = rot_mat[4];
        this.up[1] = rot_mat[5];
        this.up[2] = rot_mat[6];

        this.dir[0] = rot_mat[8];
        this.dir[1] = rot_mat[9];
        this.dir[2] = rot_mat[10];

        this.right[0] = rot_mat[0];
        this.right[1] = rot_mat[1];
        this.right[2] = rot_mat[2];
    }

    update(delta) {
        this.rotate_speed = parseFloat($('#rotate_speed').val());
        this.move_speed = (this.percent_c * Fixed.lightspeed_mps).toFixed(4);
        this.percent_c = parseFloat($('#movement_speed').val()).toFixed(2);
        this.pos = Vec3.add(this.pos, this.pos, Vec3.scale(Vec3.create(), this.velocity, delta));
        if (this.omega_x !== 0.0 || this.omega_y !== 0.0) {
            let d_theta_x = this.omega_x * delta;
            let d_theta_y = this.omega_y * delta;
            this.omega_y *= this._damper_r;
            this.omega_x *= this._damper_r;
            let o_x = Math.abs(this.omega_y), o_y = Math.abs(this.omega_x);
            let limit = .01;
            if (o_x < limit) {     
                this.omega_y = 0.0;
            }
            if (o_y < limit) {       
                this.omega_x = 0.0;
            }
            if (o_x + o_y < limit) {
                this._damper_r = 1.0;
            }
            let rot_mat = this.rot_mat;

            Mat4.rotateY(rot_mat, rot_mat, d_theta_y);
            Mat4.rotateX(rot_mat, rot_mat, d_theta_x);
            this.set_dirs();
            this.rot_mat = rot_mat;
            console.log('Cam: ', this.pos, this.velocity, 'Dir:', this.dir, 'Right:', this.right, this.up, 'Len ', Vec3.len(this.dir));
        }

        if (Tracking.locked_to_js_obj) {
            let to = Vec3.subtract(Vec3.create(), Tracking.locked_to_js_obj.pos, this.pos);
            Vec3.negate(to);
            let dist = Vec3.len(to) - Math.max((3*Tracking.locked_to_js_obj.radius), 2.0);
            Vec3.normalize(to, to);
            Vec3.scale(to, to, dist / 10);
            if (dist > .0001) {
                Vec3.add(this.pos, this.pos, to);
            } else {
                this.velocity = [0, 0, 0];
            }

        }

        let targeted_obj = Tracking.targeted_js_obj || Tracking.auto_targeted_js_obj;

        if (targeted_obj && this._slerp.t === 0.0) {
            let to = Vec3.subtract(Vec3.create(), targeted_obj.pos, this.pos);
            Vec3.normalize(to, to);
            to = Vec3.negate(to);

            if (Tracking.auto_targeted_js_obj) {
                if (Vec3.dot(this.dir, to) > .999 || Vec3.len(this.velocity) > 0.00001) {
                    return;
                }
            }

            let up = Vec3.create(0, 1, 0);
            if (Math.abs(Vec3.dot(to, up)) > .9) {
                up = Vec3.create(-1, 0, 0);
            }
            let right = Vec3.cross(Vec3.create(), up, to);
            Vec3.normalize(right, right);
            up = Vec3.cross(up, to, right);
            Vec3.normalize(up, up);

            let qstart = Quat.identity(), qend = Quat.identity();
            let m = new Float32Array([...right, 0, ...up, 0, ...to, 0, 0, 0, 0, 1]);
            Mat4.fromQuat(Mat4.identity(), Quat.fromMat3(qend, Mat4.toMat3(m)));

            Quat.fromMat3(qstart, Mat4.toMat3(this.rot_mat));
            this.set_dirs();
            this._slerp = { start: qstart, end: qend, t: 0.001 }
            console.log('To ', to, 'Dir ', this.dir);

        }
        let max = 1.0;
        if (this._slerp.t > 0) {
            if (!targeted_obj) {
                this._slerp.t = 0.0;
                return;
            }
            this._slerp.t = Math.min(max, this._slerp.t + delta)
            let q = Quat.slerp(Quat.identity(), this._slerp.start, this._slerp.end, this._slerp.t);
            Mat4.fromQuat(this.rot_mat, q);
            console.log('Tracking...', this._slerp.t);
            this.set_dirs();
        }

        if (this._slerp.t >= max) {
            console.log('Cam: ', this.pos, this.velocity, 'Dir:', Vec3.negate(this.dir), 'Right:', this.right, this.up, 'Len ', Vec3.len(this.dir));
            this._slerp.t = 0.0;
            Tracking.targeted_js_obj = null;
        }


        //console.log('Cam: ', this.pos, this.velocity, 'Dir:', this.dir, 'Right:', this.right, this.up);
    }

    get matrix() {
        let mat = Mat4.identity();
        //let mrot = new Float32Array([...this.right, 0, ...this.up, 0, ...this.dir, 0, 0, 0, 0, 1])
        Mat4.translate(mat, mat, this.pos);
        Mat4.multiply(mat, mat, this.rot_mat);
        Mat4.invert(mat, mat);
        Mat4.multiply(mat, this.p_mat, mat);
        return mat;
    }
}

class Planet {
    constructor(pos, vel, omega, radius, axial_tilt, image, display) {
        this.pos = pos;
        this.vel = vel;
        this.radius = radius;
        this.axial_tilt = axial_tilt;
        this.image = image;
        this.triangle_mesh = genUnitSphereMesh(20, 20);
        this.dir = [0, 0, 1];
        this.v_up = [Math.sin(axial_tilt), Math.cos(axial_tilt), 0];
        this.theta = 0.0;
        this.omega = omega;
        this.rot_mat = Mat4.identity();
        this.instrinsic = 0.0;
        this.display = display
    }

    update(delta) {
        this.theta += (this.omega * delta);
    }

    get matrix() {
        let q = Quat.identity();
        Quat.setAxisAngle(q, this.v_up, this.theta);
        let model_matrix = Mat4.fromQuat(Mat4.identity(), q);
        let sc = Vec3.create(this.radius, this.radius, this.radius);
        Mat4.scale(model_matrix, model_matrix, sc);
        let tm = Mat4.identity();
        Mat4.translate(tm, tm, Vec3.create(...this.pos));
        Mat4.multiply(model_matrix, tm, model_matrix);
        return model_matrix;
    }
}


class Renderer {
    constructor(gl, object_list) {
        let main = getProgram(gl, resources.shaders.s_vs, resources.shaders.s_fs);
        let mesh = getProgram(gl, resources.shaders.s_vs, resources.shaders.mesh_fs);
        let sky = getProgram(gl, resources.shaders.sky_vs, resources.shaders.sky_fs);

        this.main = {
            prog: main,
            tex_coord_loc: gl.getAttribLocation(main, "a_tex_coord"),
            pos_att_loc: gl.getAttribLocation(main, "a_position"),
            model_mat_loc: gl.getUniformLocation(main, 'model_matrix'),
            view_mat_loc: gl.getUniformLocation(main, 'view_matrix'),
            light_pos_loc: gl.getUniformLocation(main, 'u_world_light_pos'),
            intrinsic_loc: gl.getUniformLocation(main, 'u_intrinsic_bright'),
        };

        this.mesh = {
            prog: mesh,
            tex_coord_loc: gl.getAttribLocation(mesh, "a_tex_coord"),
            pos_att_loc: gl.getAttribLocation(mesh, "a_position"),
            model_mat_loc: gl.getUniformLocation(mesh, 'model_matrix'),
            view_mat_loc: gl.getUniformLocation(mesh, 'view_matrix'),
        };
        let m = Mat4.identity();
        this.sky = {
            prog: sky,
            sampler_cube_loc: gl.getUniformLocation(sky, 'u_sampler_cube'),
            view_mat_loc: gl.getUniformLocation(sky, 'view_matrix'),
            pos_att_loc: gl.getAttribLocation(sky, 'a_position'),
            texture: gl.createTexture(),
            texture_targets: {
                [PX]: gl.TEXTURE_CUBE_MAP_POSITIVE_X,
                [PY]: gl.TEXTURE_CUBE_MAP_POSITIVE_Y,
                [PZ]: gl.TEXTURE_CUBE_MAP_POSITIVE_Z,
                [NX]: gl.TEXTURE_CUBE_MAP_NEGATIVE_X,
                [NY]: gl.TEXTURE_CUBE_MAP_NEGATIVE_Y,
                [NZ]: gl.TEXTURE_CUBE_MAP_NEGATIVE_Z,
            },
            v_buffer: gl.createBuffer(),
            scale_matrix: Mat4.scale(m, m, [100000, 100000, 100000]),
        }
        this.obj_data = {};
        this.obj_list = object_list;

        this.main_enabled = true;
        document.getElementById("toggle_shader").onclick = (ev) => {
            this.main_enabled = !this.main_enabled;
        }
        this.buffer_objects(gl);
    }

    buffer_objects(gl) {
        for (let i = 0; i < this.obj_list.length; i++) {
            let obj = this.obj_list[i];
            let mesh = obj.triangle_mesh;

            let texture = gl.createTexture();
            let v_buffer = gl.createBuffer();
            let t_buffer = gl.createBuffer();
            let i_buffer = gl.createBuffer();

            gl.bindBuffer(gl.ARRAY_BUFFER, t_buffer);
            gl.bufferData(gl.ARRAY_BUFFER, mesh.tex_coords, gl.STATIC_DRAW);

            gl.bindBuffer(gl.ARRAY_BUFFER, v_buffer);
            gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);

            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, i_buffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.tri_indices, gl.STATIC_DRAW);

            this.obj_data[obj] = {
                texture: texture,
                v_buffer: v_buffer,
                t_buffer: t_buffer,
                i_buffer: i_buffer
            };
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, this.sky.v_buffer);
        gl.bufferData(gl.ARRAY_BUFFER, SkyBoxVertices, gl.STATIC_DRAW);
    }

    draw(gl, obj, cam_view_mat) {
        //gl.enable(gl.CULL_FACE);

        let source = this.main_enabled ? this.main : this.mesh;

        var { pos_att_loc, tex_coord_loc, prog, model_mat_loc, view_mat_loc, light_pos_loc, intrinsic_loc } = source;
        gl.useProgram(prog);
        gl.uniformMatrix4fv(view_mat_loc, false, cam_view_mat);
        gl.uniform3fv(light_pos_loc, Vec3.create(0, 0, 0));

        let { texture, v_buffer, t_buffer, i_buffer } = this.obj_data[obj];
    
        gl.bindBuffer(gl.ARRAY_BUFFER, v_buffer);
        gl.enableVertexAttribArray(pos_att_loc);
        gl.vertexAttribPointer(pos_att_loc, 3, gl.FLOAT, false, 0, 0);

        gl.uniformMatrix4fv(model_mat_loc, false, obj.matrix);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, i_buffer);

        if (this.main_enabled) {
            gl.bindBuffer(gl.ARRAY_BUFFER, t_buffer)
            gl.enableVertexAttribArray(tex_coord_loc);
            gl.vertexAttribPointer(tex_coord_loc, 2, gl.FLOAT, false, 0, 0);

            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, obj.image);
            gl.generateMipmap(gl.TEXTURE_2D);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

            gl.uniform1f(intrinsic_loc, obj.instrinsic);

            gl.drawElements(gl.TRIANGLES, obj.triangle_mesh.tri_indices.length, gl.UNSIGNED_SHORT, 0);
        }
        else {
            //gl.drawArrays(gl.LINE_STRIP, 0, obj.triangle_mesh.vertices.length/3);
            gl.drawElements(gl.LINE_STRIP, obj.triangle_mesh.tri_indices.length, gl.UNSIGNED_SHORT, 0);
        }
    }

    load_skybox(gl) {
        var { pos_att_loc, prog, texture, sampler_cube_loc, view_mat_loc, texture_targets, v_buffer, scale_matrix } = this.sky;
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, texture);

        SKY_IMAGES.forEach((v, i, a) => {
            gl.texImage2D(texture_targets[v], 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, resources.images[v]);
        });
        gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
        
    draw_skybox(gl) {
        var { pos_att_loc, prog, texture, sampler_cube_loc, view_mat_loc, texture_targets, v_buffer, scale_matrix } = this.sky;
        gl.useProgram(prog);
        
        let m = Mat4.identity();
        Mat4.multiply(m, m, cam.rot_mat);
        Mat4.invert(m, m);
        Mat4.multiply(m, scale_matrix, m);
        Mat4.multiply(m, cam.p_mat, m);
        gl.uniformMatrix4fv(view_mat_loc, false, m);
        gl.uniform1i(sampler_cube_loc, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, v_buffer);
        gl.enableVertexAttribArray(pos_att_loc);
        gl.vertexAttribPointer(pos_att_loc, 3, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 36);

        //gl.drawArrays(gl.LINE_STRIP, 0, 36);
    }
}
var cam = new Camera([0, 0, Fixed.dist.e2s + 20]);
var sim_paused = false;
var main_canvas = document.getElementById("canvas_1");
var Tracking = {
    targeted_js_obj: null,
    auto_targeted_js_obj: null,
    locked_to_js_obj: null,
    _lock_button: null,
    _auto_button: null,
    target: (obj) => {
        Tracking.targeted_js_obj = obj;
        Tracking.disable_auto_targeting();
    },
    disable_auto_targeting: () => {
        if (Tracking._auto_button) {
            Tracking._auto_button.removeClass("t_btn_on");
        }
        Tracking.auto_targeted_js_obj = null;
    },
    disable_lock: () => {
        if (Tracking._lock_button) {
            Tracking._lock_button.removeClass("t_btn_on");
        }
        Tracking.locked_to_js_obj = null;
    },
    enable_auto_targeting: (button, obj) => {
        Tracking.targeted_js_obj = null;
        let toggle = obj == Tracking.auto_targeted_js_obj;
        Tracking.disable_auto_targeting();
        if (!toggle) {
            Tracking.auto_targeted_js_obj = obj;
            Tracking._auto_button = button;
            Tracking._auto_button.addClass("t_btn_on");
        }
    },
    enable_lock: (button, obj) => {
        let toggle = obj == Tracking.locked_to_js_obj;
        Tracking.disable_lock();
        if (!toggle) {
            Tracking.locked_to_js_obj = obj;
            Tracking._lock_button = button;
            Tracking._lock_button.addClass("t_btn_on");
        }
    }
}
var DisplayStats = {
    vars: {
        cam2sun: Vec3.create(),
    },
    elements: {
        cam2sun: $('<div/>'),
        time2sun: $('<div/>')
    },
    setup: () => {
        Object.values(DisplayStats.elements).forEach((v, i, a) => {
            $('#stats_overlay_1').append(v);
        });
    },
    update: () => {
        Vec3.subtract(DisplayStats.vars.cam2sun, Vec3.create(), cam.pos);
        let units = Vec3.len(DisplayStats.vars.cam2sun);
        let miles = units * EARTH_RADIUS;

        DisplayStats.elements.cam2sun.html(`Distance to Sun: ${parseFloat(miles).toFixed(0)} mi`);
        DisplayStats.elements.time2sun.html(`Time to Sun: ${(units / cam.move_speed / 60).toFixed(2)} minutes @${cam.percent_c}<i>c</i>`);
        return miles;
    }

}

var handle;

async function start() {
    let gl = getGLContext(main_canvas);
    let timer = new Timer();

    await resources.wait_until_loaded();


    let earth = new Planet(Vec3.create(0, 0, Fixed.dist.e2s), Vec3.create(), .1, Fixed.rad.earth, .4, resources.images.earth, { name: 'Earth' });
    let moon = new Planet(Vec3.create(Fixed.dist.m2e, 0, Fixed.dist.e2s), Vec3.create(), .3, Fixed.rad.moon, 0, resources.images.moon, { name: 'Moon' });
    let sun = new Planet(Vec3.create(0, 0, 0), Vec3.create(), .01, Fixed.rad.sun, 0, resources.images.sun, { name: 'Sun' });
   
    earth.instrinsic = .5;
    let objs = [earth, moon, sun];
    
    PLANETS.forEach((v) => {
        let {dist, rad} = Fixed.rel[v];
        let p = new Planet(Vec3.create(0, 0, Fixed.au_2_units(dist)), Vec3.create(), .1, rad, 0, resources.images[v], {name: v});
        objs.push(p);
        //console.log(v, Vec3.len(p.pos));
    });
    $('#loader_canvas').remove();
    let renderer = new Renderer(gl, objs);
    renderer.load_skybox(gl);
    handle = window.setInterval(() => {
        try {
            $("#rotate_speed_label").html(`Pan speed: ${cam.rotate_speed} rad/s`);
            $("#movement_speed_label").html(`Movement speed: ${(cam.move_speed * EARTH_RADIUS).toFixed(2)} mps (${cam.percent_c}c)`);
            let m = DisplayStats.update();
  
            sun.instrinsic = Math.min(10.0, 2.0 + (5.0 * ((m/4000000))));
            timer.start();
            cam.update(.1);
            let w = gl.canvas.clientWidth, h = gl.canvas.clientHeight;
            let aspect = parseFloat(w) / parseFloat(h);
            if (aspect !== cam.aspect) {
                gl.canvas.width = w;
                gl.canvas.height = h;
                gl.viewport(0, 0, w, h);
                cam.set_aspect(aspect);
            } 
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            gl.enable(gl.DEPTH_TEST);         
            let mat = cam.matrix;

            if (!sim_paused) {
                objs.forEach((o) => { o.update(.1) });
            }
            renderer.draw_skybox(gl);
            objs.forEach((o) => {
                let to = Vec3.subtract(Vec3.create(), cam.pos, o.pos);
                if (Vec3.len(to) < 5000 || o === sun) {
                    renderer.draw(gl, o, mat);
                }
            });
            //console.log(timer.stop() + ' ms');
            //window.clearInterval(handle);
        }
        catch (error) {
            console.log(error);
            console.log(gl.getError());
            window.clearInterval(handle);;
        }
    }, 100);

    objs.forEach((v, i, a) => {
        let d = $("<div/>").addClass("object_viewer");
        let d2 = $('<div/>').addClass('thumb');
        d2.append(v.image);
        d.append(d2);
        d.append("<span>" + v.display.name + "</span>");

        let b1 = $("<button/>").addClass("transparent_button").html("Look At");
        let b2 = $("<button/>").addClass("transparent_button").html("Auto Look At");
        let b3 = $("<button/>").addClass("transparent_button").html("Auto Go To");

        b1.click((ev) => { Tracking.target(v) });
        b2.click((ev) => { Tracking.enable_auto_targeting(b2, v) });
        b3.click((ev) => { Tracking.enable_lock(b3, v) });

        d.append([b1, b2, b3]);
        $('#objects_dropdown').append(d);

    });
}

document.addEventListener("DOMContentLoaded", (ev) => {
    let btn = $("#pause_sim");
    btn.click((ev) => {
        sim_paused = !sim_paused;
        if (sim_paused) {
            btn.html('Resume Simulation');
        }
        else {
            btn.html('Pause Simulation');
        }
    });
    DisplayStats.setup();
    document.getElementById('movement_speed').step = 0.1;
    document.getElementById('movement_speed').value = 1.0;
    document.getElementById('rotate_speed').step = 0.1;
    document.getElementById('rotate_speed').value = 0.5;
    start();

});
