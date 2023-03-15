# Preview

[Badges]

[Terminal GIF]

Preview is a CLI tool for provisioning preview environments.  
Using preview, you can provision `any docker compose app on your favorite cloud (currently AWS is only supported)    
This project is part of Liveycle's vision of making preview environments mainstream and integral part of any development flow.  

## Why?

Preview environments are non-production ephemeral environment that are created for each pull request.  
Such environments, can be extremely useful for improving PR workflows and became quite common in the latest years and even been deeply integrated by some PaaS providers (most notability in FE delivery platforms).  

Despite the value of preview environments, setting up preview environments can be non-trivial task in terms of automation, configuration, operation, complexity and cost.  

This tool designed to simplify this process and provide a framework for utilizing preview environment to optimize the PR flow.  

You can read more about the story and philosophy behind this CLI here.  

## Getting started

To start using the CLI you first need:  
- a local AWS configuration (can be achieved by using the `aws login` or `aws configure`)  
- docker-compose application (example can be in awesome compose)  

You can install the CLI using npm:  
`npm install -g preview`  
or use it directly using:  
`npx preview <command>`  

Start by setting up a profile by using:  `preview init`  

Afterwards, use `up` command to provision a new vm (lightsail) with your application.  
`preview up`  

Try accessing the application by using the `*.livecycle.run` urls generated for your app.  

Destroy the environment by using: `preview down`  

## Under the hood

The preview tool is composed of two main components:  

#### CLI (packages/cli)

The CLI is a node.js program responsible for:  
- Provisioning and tearing down vms.
- Exposing environments state and urls to end user. 
- Storing & accessing profile data. (settings, keys, etc...)
- Setup vm with Docker tooling
- Syncing compose source code and local volumes
- Running the application and install daemon for connecting to the proxy service.  

#### Proxy/Tunneling service (packages/proxy)

The proxy service is a node.js responsible for exposing friendly https urls for the compose services.  
Can be self hosted, a free public instance is hosted on `livecycle.run`.  

A Docker/OCI image is available on ghcr.io:  

## CI Integration

The preview CLI is designed to work as part of your CI.  
For accomplishing that, you need to have a shared profile stored in s3. (more storage provider are on the way)

It can be created by using `preview init` and choosing s3 url for storing the profile. (bucket will be created automatically if doesn't exists).

Afterwards, the exact profile can be imported to the CI using `preview init --from <s3-url>`

## Security

In case you find a security issue or have something you would like to discuss refer to our security.md policy.

#### Notice on preview environments exposure
VMs are not exposed directly and instead or exposed via a tunnel created by the tunneling/proxy service.  
Every compose service is exposed with a url that is based on:  
`https://{service}-{[port]}-{envId}-{clientId}.{proxy-service}`  
EnvId can be specified by the `up` command `id` flag, or by automatically generated by git context.  
ClientId is unique identified based on the profile public tunneling SSH key (generated in init).  
When using the `*.livecycle.run`, all environments are publicly accessible assuming you have the urls.  

## Contributing
Found a bug? Have a missing feature? Please open an issue and let us know.