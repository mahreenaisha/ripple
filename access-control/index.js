"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseYaml } = require("./yaml");

const ASSIGNMENT_ROLES = new Set(["core", "occasional", "on-call"]);
const ACCESS_LEVELS = new Set(["standard", "admin", "read-only"]);

function readYaml(filePath) {
  return parseYaml(fs.readFileSync(filePath, "utf8"));
}

function requireString(value, field, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${field} must be a non-empty string`);
  }
}

function requireStringArray(value, field, errors) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    errors.push(`${field} must be a list of strings`);
  }
}

function validateData(usersDocument, servicesDocument) {
  const errors = [];
  const users = usersDocument.users;
  const services = servicesDocument.services;

  if (usersDocument.schema_version !== 1) errors.push("users.yaml schema_version must be 1");
  if (servicesDocument.schema_version !== 1) errors.push("services.yaml schema_version must be 1");
  if (!Array.isArray(users)) errors.push("users.yaml users must be a list");
  if (!Array.isArray(services)) errors.push("services.yaml services must be a list");
  if (errors.length) throw new Error(`Invalid access-control data:\n- ${errors.join("\n- ")}`);

  const serviceIds = new Set();
  for (const [index, service] of services.entries()) {
    const field = `services[${index}]`;
    requireString(service.id, `${field}.id`, errors);
    requireString(service.name, `${field}.name`, errors);
    if (serviceIds.has(service.id)) errors.push(`${field}.id is duplicated: ${service.id}`);
    serviceIds.add(service.id);
    requireStringArray(service.repos, `${field}.repos`, errors);
    requireStringArray(service.confluence, `${field}.confluence`, errors);
    requireStringArray(service.databases, `${field}.databases`, errors);
    requireStringArray(service.external_services, `${field}.external_services`, errors);
    if (!service.deployment || typeof service.deployment !== "object") {
      errors.push(`${field}.deployment must contain environment and region`);
    } else {
      for (const key of ["environment", "region"]) {
        if (service.deployment[key] !== null && typeof service.deployment[key] !== "string") {
          errors.push(`${field}.deployment.${key} must be a string or null`);
        }
      }
    }
  }

  const userIds = new Set();
  for (const [index, user] of users.entries()) {
    const field = `users[${index}]`;
    for (const key of ["id", "name", "team", "role"]) {
      requireString(user[key], `${field}.${key}`, errors);
    }
    if (userIds.has(user.id)) errors.push(`${field}.id is duplicated: ${user.id}`);
    userIds.add(user.id);
    if (!ACCESS_LEVELS.has(user.access_level)) {
      errors.push(`${field}.access_level must be standard, admin, or read-only`);
    }
    if (!Array.isArray(user.services)) {
      errors.push(`${field}.services must be a list`);
      continue;
    }
    const assignments = new Set();
    for (const [assignmentIndex, assignment] of user.services.entries()) {
      const assignmentField = `${field}.services[${assignmentIndex}]`;
      if (!serviceIds.has(assignment.service_id)) {
        errors.push(`${assignmentField}.service_id is unknown: ${assignment.service_id}`);
      }
      if (assignments.has(assignment.service_id)) {
        errors.push(`${assignmentField}.service_id is duplicated: ${assignment.service_id}`);
      }
      assignments.add(assignment.service_id);
      if (!ASSIGNMENT_ROLES.has(assignment.role)) {
        errors.push(`${assignmentField}.role must be core, occasional, or on-call`);
      }
    }
  }

  if (errors.length) throw new Error(`Invalid access-control data:\n- ${errors.join("\n- ")}`);
}

function unique(values) {
  return [...new Set(values)];
}

function createAccessCatalog(options = {}) {
  const usersPath = options.usersPath || path.join(__dirname, "users.yaml");
  const servicesPath = options.servicesPath || path.join(__dirname, "services.yaml");
  const usersDocument = readYaml(usersPath);
  const servicesDocument = readYaml(servicesPath);
  validateData(usersDocument, servicesDocument);

  const usersById = new Map(usersDocument.users.map((user) => [user.id, user]));
  const servicesById = new Map(
    servicesDocument.services.map((service) => [service.id, service]),
  );

  function getUser(userId) {
    const user = usersById.get(userId);
    if (!user) throw new Error(`Unknown user: ${userId}`);
    return user;
  }

  function getService(serviceId) {
    const service = servicesById.get(serviceId);
    if (!service) throw new Error(`Unknown service: ${serviceId}`);
    return service;
  }

  function getUserServices(userId) {
    return getUser(userId).services.map((assignment) => assignment.service_id);
  }

  function getServiceRepos(serviceId) {
    return [...getService(serviceId).repos];
  }

  function getUserAccess(userId) {
    const assignedServices = getUserServices(userId).map(getService);
    return {
      repos: unique(assignedServices.flatMap((service) => service.repos)),
      spaces: unique(assignedServices.flatMap((service) => service.confluence)),
      databases: unique(assignedServices.flatMap((service) => service.databases)),
      services: unique(assignedServices.flatMap((service) => service.external_services)),
    };
  }

  function canAccess(userId, serviceId) {
    if (!usersById.has(userId) || !servicesById.has(serviceId)) return false;
    return getUserServices(userId).includes(serviceId);
  }

  function getUsersForService(serviceId) {
    getService(serviceId);
    return usersDocument.users
      .filter((user) =>
        user.services.some((assignment) => assignment.service_id === serviceId),
      )
      .map((user) => user.id);
  }

  return {
    canAccess,
    getServiceRepos,
    getUserAccess,
    getUserServices,
    getUsersForService,
  };
}

const catalog = createAccessCatalog();

module.exports = {
  ...catalog,
  createAccessCatalog,
  validateData,
};
