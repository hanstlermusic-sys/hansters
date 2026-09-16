// Pruebas del Mock API local (mock-api.js).
// Cubre las funciones puras y ademas levanta el servidor de verdad en un
// puerto libre para comprobar el ciclo completo: generar, cachear, forzar
// escenarios de error y sembrar respuestas a mano. No usa red externa:
// el generador se inyecta de mentira.
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// La cache vive en ~/.hanstlers/mocks. Para no tocar la del usuario,
// apuntamos HOME/USERPROFILE a una carpeta temporal ANTES de requerir.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-mock-'));
process.env.USERPROFILE = TMP;
process.env.HOME = TMP;

const mock = require('../mock-api');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '  -> ' + e.message); }
}
const pendientes = [];
function ta(name, fn) { pendientes.push({ name, fn }); }

console.log('\n--- parseMockRequest ---');

t('separa ruta, escenario y status de los parametros de control', () => {
  const i = mock.parseMockRequest('post', '/api/paypal/order?page=2&__scenario=rechazado&__status=402');
  assert.strictEqual(i.method, 'POST');
  assert.strictEqual(i.pathname, '/api/paypal/order');
  assert.strictEqual(i.scenario, 'rechazado');
  assert.strictEqual(i.status, 402);
  assert.deepStrictEqual(i.query, { page: '2' });
});

t('status invalido o ausente cae a 200', () => {
  assert.strictEqual(mock.parseMockRequest('GET', '/a').status, 200);
  assert.strictEqual(mock.parseMockRequest('GET', '/a?__status=999').status, 200);
  assert.strictEqual(mock.parseMockRequest('GET', '/a?__status=abc').status, 200);
});

console.log('\n--- mockCacheKey ---');

t('la query normal no cambia la clave, el escenario si', () => {
  const a = mock.parseMockRequest('GET', '/productos?page=1');
  const b = mock.parseMockRequest('GET', '/productos?page=2');
  const c = mock.parseMockRequest('GET', '/productos?__scenario=vacio');
  assert.strictEqual(a.key, b.key, 'la paginacion no debe partir la cache');
  assert.notStrictEqual(a.key, c.key, 'el escenario debe tener su propia cache');
});

t('metodo y ruta distintos dan claves distintas', () => {
  assert.notStrictEqual(mock.mockCacheKey('GET', '/a', ''), mock.mockCacheKey('POST', '/a', ''));
  assert.notStrictEqual(mock.mockCacheKey('GET', '/a', ''), mock.mockCacheKey('GET', '/b', ''));
});

console.log('\n--- extractJson ---');

t('lee JSON pelado', () => {
  assert.deepStrictEqual(mock.extractJson('{"ok":true}'), { ok: true });
});

t('lee JSON dentro de un bloque markdown', () => {
  assert.deepStrictEqual(mock.extractJson('```json\n{"id":7}\n```'), { id: 7 });
});

t('rescata el JSON aunque el modelo anada explicacion alrededor', () => {
  assert.deepStrictEqual(mock.extractJson('Claro, aqui tienes:\n{"a":{"b":1}}\nEspero sirva.'), { a: { b: 1 } });
});

t('soporta arrays y llaves dentro de cadenas', () => {
  assert.deepStrictEqual(mock.extractJson('texto [1,2] fin'), [1, 2]);
  assert.deepStrictEqual(mock.extractJson('{"s":"} no cierra {"}'), { s: '} no cierra {' });
});

t('devuelve null si no hay JSON', () => {
  assert.strictEqual(mock.extractJson('no hay nada aqui'), null);
  assert.strictEqual(mock.extractJson(''), null);
  assert.strictEqual(mock.extractJson('{roto'), null);
});

console.log('\n--- fallbackMock ---');

t('un recurso en plural devuelve lista', () => {
  const r = mock.fallbackMock({ pathname: '/api/productos', status: 200, scenario: '' });
  assert.strictEqual(r.ok, true);
  assert.ok(Array.isArray(r.items) && r.items.length === 2);
});

t('un recurso en singular devuelve objeto', () => {
  const r = mock.fallbackMock({ pathname: '/api/license', status: 200, scenario: '' });
  assert.strictEqual(r.ok, true);
  assert.ok(!Array.isArray(r.items));
  assert.ok(String(r.id).includes('license'));
});

t('la ruta de PayPal devuelve forma de orden compatible con checkout', () => {
  const r = mock.fallbackMock({ pathname: '/api/paypal/order', status: 200, scenario: '' });
  assert.strictEqual(r.status, 'CREATED');
  assert.strictEqual(r.intent, 'CAPTURE');
  assert.ok(Array.isArray(r.purchase_units) && r.purchase_units.length === 1);
  assert.ok(Array.isArray(r.links) && r.links.some((l) => l.rel === 'approve'));
});

t('status de error o escenario de fallo devuelve error', () => {
  assert.strictEqual(mock.fallbackMock({ pathname: '/api/pago', status: 500, scenario: '' }).ok, false);
  assert.strictEqual(mock.fallbackMock({ pathname: '/api/pago', status: 200, scenario: 'rechazado' }).ok, false);
});

console.log('\n--- promptFor ---');

t('el prompt lleva metodo, ruta y escenario', () => {
  const p = mock.promptFor(
    { method: 'POST', pathname: '/api/pago', query: { moneda: 'CRC' }, scenario: 'rechazado', status: 402 },
    '{"monto":10}'
  );
  assert.ok(p.includes('POST') && p.includes('/api/pago'));
  assert.ok(p.includes('rechazado') && p.includes('402'));
  assert.ok(p.includes('CRC') && p.includes('monto'));
});

// --- Servidor real ---

function pedir(puerto, metodo, ruta, cuerpo, cb) {
  const req = http.request({ host: '127.0.0.1', port: puerto, method: metodo, path: ruta }, (res) => {
    let raw = '';
    res.on('data', (d) => (raw += d));
    res.on('end', () => {
      let j = null;
      try { j = JSON.parse(raw); } catch (e) {}
      cb(null, { status: res.statusCode, headers: res.headers, json: j, raw });
    });
  });
  req.on('error', cb);
  if (cuerpo) req.write(cuerpo);
  req.end();
}

console.log('\n--- servidor ---');

let llamadasIA = 0;
const generadorFalso = (prompt, cb) => {
  llamadasIA++;
  setTimeout(() => cb(null, '```json\n{"generado":true,"ruta":"' + String(prompt).length + '"}\n```'), 5);
};

mock.start({ port: 0, generate: generadorFalso }, (err, info) => {
  if (err) { console.error('No se pudo levantar el mock: ' + err.message); process.exit(1); }
  const puerto = info.puerto;

  const pruebas = [
    (next) => {
      pedir(puerto, 'GET', '/__mock/health', null, (e, r) => {
        t('health responde y reporta puerto e IA', () => {
          assert.ifError(e);
          assert.strictEqual(r.status, 200);
          assert.strictEqual(r.json.ok, true);
          assert.strictEqual(r.json.puerto, puerto);
          assert.strictEqual(r.json.ia, true);
        });
        next();
      });
    },
    (next) => {
      pedir(puerto, 'GET', '/api/productos', null, (e, r) => {
        t('una ruta cualquiera devuelve el JSON generado por la IA', () => {
          assert.ifError(e);
          assert.strictEqual(r.status, 200);
          assert.strictEqual(r.json.generado, true);
          assert.strictEqual(r.headers['x-hanstlers-mock'], '1');
          assert.strictEqual(r.headers['access-control-allow-origin'], '*');
        });
        next();
      });
    },
    (next) => {
      const antes = llamadasIA;
      pedir(puerto, 'GET', '/api/productos?page=9', null, (e, r) => {
        t('la segunda llamada sale de cache y no vuelve a gastar IA', () => {
          assert.ifError(e);
          assert.strictEqual(r.json.generado, true);
          assert.strictEqual(llamadasIA, antes, 'no debio llamar a la IA otra vez');
        });
        next();
      });
    },
    (next) => {
      pedir(puerto, 'GET', '/api/pago?__status=500&__scenario=caido', null, (e, r) => {
        t('__status fuerza el codigo HTTP del error', () => {
          assert.ifError(e);
          assert.strictEqual(r.status, 500);
        });
        next();
      });
    },
    (next) => {
      const seed = JSON.stringify({ path: '/api/licencia', data: { licencia: 'PRO', vence: '2027-01-01' }, status: 201 });
      pedir(puerto, 'POST', '/__mock/seed', seed, (e, r) => {
        t('seed acepta una respuesta fijada a mano', () => {
          assert.ifError(e);
          assert.strictEqual(r.status, 200);
          assert.strictEqual(r.json.ok, true);
        });
        pedir(puerto, 'GET', '/api/licencia', null, (e2, r2) => {
          t('la respuesta sembrada se sirve tal cual y con su status', () => {
            assert.ifError(e2);
            assert.strictEqual(r2.status, 201);
            assert.strictEqual(r2.json.licencia, 'PRO');
          });
          next();
        });
      });
    },
    (next) => {
      pedir(puerto, 'POST', '/__mock/seed', JSON.stringify({ nada: 1 }), (e, r) => {
        t('seed sin path ni data responde 400', () => {
          assert.ifError(e);
          assert.strictEqual(r.status, 400);
          assert.strictEqual(r.json.ok, false);
        });
        next();
      });
    },
    (next) => {
      pedir(puerto, 'POST', '/__mock/clear', null, (e, r) => {
        t('clear vacia la cache', () => {
          assert.ifError(e);
          assert.strictEqual(r.json.ok, true);
          assert.ok(r.json.borrados >= 1);
          assert.strictEqual(mock.listCache().length, 0);
        });
        next();
      });
    },
    (next) => {
      // Sin generador debe seguir respondiendo con el respaldo local.
      mock.setGenerator(null);
      pedir(puerto, 'GET', '/api/facturas', null, (e, r) => {
        t('sin IA configurada responde igual con el respaldo local', () => {
          assert.ifError(e);
          assert.strictEqual(r.status, 200);
          assert.strictEqual(r.json.ok, true);
          assert.ok(Array.isArray(r.json.items));
        });
        next();
      });
    },
    (next) => {
      mock.setGenerator((p, cb) => cb(new Error('vertex caido')));
      pedir(puerto, 'GET', '/api/reporte', null, (e, r) => {
        t('si la IA falla no rompe: cae al respaldo', () => {
          assert.ifError(e);
          assert.strictEqual(r.status, 200);
          assert.strictEqual(r.json.ok, true);
        });
        next();
      });
    },
    (next) => {
      // El respaldo por fallo de IA no debe quedarse cacheado: si Vertex se
      // cae un momento, la siguiente llamada tiene que reintentar.
      t('un respaldo por fallo de IA no se cachea', () => {
        assert.ok(!mock.listCache().some((c) => c.pathname === '/api/reporte'),
          '/api/reporte no debia quedar en cache');
      });
      mock.setGenerator((p, cb) => cb(null, '{"recuperado":true}'));
      pedir(puerto, 'GET', '/api/reporte', null, (e, r) => {
        t('tras recuperarse la IA, la misma ruta ya devuelve el JSON bueno', () => {
          assert.ifError(e);
          assert.strictEqual(r.json.recuperado, true);
        });
        next();
      });
    },
    (next) => {
      t('status() refleja que esta activo', () => {
        const s = mock.status();
        assert.strictEqual(s.activo, true);
        assert.strictEqual(s.puerto, puerto);
        assert.ok(s.url.includes(String(puerto)));
      });
      next();
    }
  ];

  let i = 0;
  const siguiente = () => {
    if (i >= pruebas.length) return terminar();
    const p = pruebas[i++];
    p(siguiente);
  };

  function terminar() {
    mock.stop(() => {
      t('stop() deja el servidor inactivo', () => {
        assert.strictEqual(mock.isRunning(), false);
      });
      try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
      console.log('\n' + pass + ' pruebas OK, ' + fail + ' fallidas');
      process.exit(fail ? 1 : 0);
    });
  }

  siguiente();
});

setTimeout(() => {
  console.error('\nLas pruebas del mock se colgaron (timeout 20s)');
  process.exit(1);
}, 20000).unref();
