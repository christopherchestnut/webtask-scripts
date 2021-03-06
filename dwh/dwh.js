/*
URL=$(wt create \
    -s pg_username=<USER> \
    -s pg_password=<PASS> \
    -s tunnel_rsa_private_key="<KEY>" \
    -s pg_db=<DB> \
    dwh.js)

curl "$URL?pg_db=<PG_DATABASE>&pg_host=<PG_HOST>&pg_port=5439&tunnel_user=<TUNNEL_USER>&tunnel_host=<TUNNEL_HOST>&q=select%20*%20from%20tenants%20limit%201"
*/

var Bluebird = require('bluebird');
var Net = require('net');
var Postgres = require('pg');
var SSH = require('ssh2');

var FORWARDER_PORT = Math.floor(4000 + Math.random() * 1000);
var tunnel$;

return function(context, req, res) {

    var err;
    ['token', 'pg_username', 'pg_password', 'tunnel_rsa_private_key'].forEach(function(i) {
        if (typeof context.secrets[i] !== 'string') {
            err = i;
        }
    });
    ['bearer_token', 'pg_host', 'pg_port', 'pg_db', 'tunnel_user', 'tunnel_host', 'q'].forEach(function(i) {
        if (typeof context.data[i] !== 'string') {
            err = i;
        }
    });
    
    if (err) {
        try {
            console.log('ERROR: request without ' + err + '.');
            res.writeHead(400);
            return res.end('Missing ' + err);
        }
        catch (e) {
            // ignore
        }
    }
    
    if (context.secrets.token !== context.data.token) {
        console.log('Unauthorized');
        res.writeHead(401);
        return res.end('Missing token');
    }

    var connOptions = "postgres://" + context.secrets.pg_username + ":" + context.secrets.pg_password + "@localhost:" + FORWARDER_PORT + "/" + context.secrets.pg_db + '?ssl=true';
    tunnel$ = tunnel$
        ?   tunnel$
        :   createTunnel({
                host: context.data.tunnel_host,
                username: context.data.tunnel_user,
                privateKey: context.secrets.tunnel_rsa_private_key.replace(/\\[n]/g, '\n'),
                pgServer: context.data.pg_host,
                pgPort: context.data.pg_port,
            });
    
    return tunnel$
        .then(onTunnelReady, onTunnelError);
        
    
    function onTunnelReady(end) {
        console.log('Got a tunnel');
        
        Postgres.connect(connOptions, function (err, client, done) {
            console.log('connected to pg');
            if (err) {
                end();
                console.log('error connecting', err);
                res.writeHead(502);
                return res.end('Error connecting to database');
            }
            client.query(context.data.q, function(err, result) {
                done();
                
                if (err) {
                    console.log('error running query', err);
                    res.writeHead(502);
                    return res.end('Error executing query');
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    rows: result.rows,
                }, null, 2));
            });
        });
    }
    
    function onTunnelError(err) {
        console.log('Unable to get tunnel', err.message);
        
        res.writeHead(500);
        res.end('Tunnel creation failed. See webtask logs.');
    }
};


function createTunnel(options) {
    return new Bluebird(function (resolve, reject) {
        var ssh = new SSH.Client();
        var connectOptions = {
            host: options.host,
            username: options.username,
            privateKey: options.privateKey
            // debug: function (msg) {
            //      console.log('DEBUG', msg);
            // }
        };
        
        console.log('Initiating connection');
        
        ssh.on('ready', onClientReady);
        ssh.on('error', onClientError);
        ssh.connect(connectOptions);
        
        return;
        function end() {
            console.log('Ending ssh tunnel');
            ssh.end();
            
            tunnel$ = null;
        }
        
        function onClientError(err) {
            console.log('Client error', err.message);
            tunnel$ = null;
            
            return reject(err);
        }
        
        function onClientReady() {
            console.log('ssh client ready');
            
            var listener = Net.createServer(function (sock) {
                console.log('Created raw network server', sock.remoteAddress, sock.remotePort);
                
                ssh.forwardOut(sock.remoteAddress, sock.remotePort, options.pgServer, options.pgPort, function (err, stream) {
                    if (err) {
                        console.log('Forwarder failed', err.message);
                        sock.end();
                        return reject(err);
                    }
                    
                    sock.pipe(stream).pipe(sock);
                    
                    console.log('Forwarder all wired up');
                });
            });
            
            listener.on('close', function () {
                console.log('Forwarder closed');
                
                end();
            });
            
            listener.on('error', function (err) {
                console.log('Forwarder error', err.message);
                
                end();
            });
            
            listener.listen(FORWARDER_PORT, function () {
                console.log('Forwarding server now listening', arguments);
                
                return resolve(end);
            });
        }
    });
}
